import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { configPath, loadConfig, saveConfig, type Account, type SlipwayConfig } from '../config.ts';
import { GiteaClient, GiteaError } from '../gitea/client.ts';
import { applyRepoAccess, setReviewRemote } from './repo.ts';
import { defaultGiteaUrl, giteaAdmin } from '../runtime/index.ts';
import { waitForGitea } from '../runtime/health.ts';

export const DEFAULT_OWNER = 'slipway';
export const DEFAULT_PASSWORD = 'slipway';
export const DEFAULT_ADMIN = 'admin';
export const DEFAULT_ORG = 'repos';
export const REVIEWERS_TEAM = 'reviewers';

export interface BootstrapOptions {
  /** Defaults to "slipway". */
  ownerUser?: string;
  ownerEmail?: string;
  ownerPassword?: string;
  giteaUrl?: string;
  /** Technical admin account (default "admin"). */
  adminUser?: string;
  /** Organization owning the review repos (default "repos"). */
  org?: string;
  log?: (msg: string) => void;
}

export const OWNER_TOKEN_SCOPES = ['all'];

async function ensureUser(username: string, email: string, password: string, admin: boolean): Promise<void> {
  const create = await giteaAdmin([
    'admin', 'user', 'create', '--username', username, '--password', password, '--email', email,
    '--must-change-password=false', ...(admin ? ['--admin'] : []),
  ]);
  if (create.code !== 0 && !/already exists/.test(create.stdout + create.stderr)) {
    throw new Error(`Creating Gitea user ${username} failed: ${create.stderr || create.stdout}`);
  }
  // Keep the password we store in sync, also for users created by an earlier run.
  const pw = await giteaAdmin(['admin', 'user', 'change-password', '--username', username, '--password', password, '--must-change-password=false']);
  if (pw.code !== 0) throw new Error(`Setting password for ${username} failed: ${pw.stderr || pw.stdout}`);
}

async function tokenWorks(giteaUrl: string, token: string, username: string): Promise<boolean> {
  try {
    const me = await new GiteaClient(giteaUrl, token).req<{ login: string }>('GET', '/user');
    return me.login === username;
  } catch {
    return false;
  }
}

/** Owner login: explicit values win; otherwise a re-run keeps the stored login (username and password); otherwise slipway / slipway (ADR 0005). */
export function resolveOwnerCredentials(
  opts: { ownerUser?: string; ownerPassword?: string },
  previous: { owner: { username: string; password: string } } | undefined,
): { username: string; password: string } {
  const username = opts.ownerUser || previous?.owner.username || DEFAULT_OWNER;
  const password = opts.ownerPassword || (previous?.owner.username === username ? previous.owner.password : DEFAULT_PASSWORD);
  return { username, password };
}

/** Keeps the plugin's Claude identity only if Gitea still accepts its token (it is gone after `down --volumes`). */
export async function keepValidClaude(previous: Account | undefined, works: (a: Account) => Promise<boolean>): Promise<Account | undefined> {
  return previous && (await works(previous)) ? previous : undefined;
}

/** Reuses a stored token if Gitea still accepts it for that user, otherwise issues a new one. */
async function tokenFor(giteaUrl: string, account: { username: string; password: string }, previousToken: string | undefined, name: string): Promise<string> {
  if (previousToken && (await tokenWorks(giteaUrl, previousToken, account.username))) return previousToken;
  return new GiteaClient(giteaUrl, { basic: [account.username, account.password] }).createToken(account.username, name, OWNER_TOKEN_SCOPES);
}

/**
 * Idempotent setup (ADR 0005):
 * - `admin`: technical Gitea admin with a random password, used only by Slipway's tooling;
 * - `slipway`: your login, a plain user (never admin) with write access to the review repos;
 * - the `repos` organization (managed by `admin`) owns the review repos.
 * Re-running keeps valid tokens, the logins and the Claude user; with a new --org the repos move there with their PRs.
 */
export async function bootstrap(opts: BootstrapOptions): Promise<SlipwayConfig> {
  const log = opts.log ?? (() => {});
  const previous = existsSync(configPath()) ? loadConfig() : undefined;
  const giteaUrl = opts.giteaUrl ?? previous?.giteaUrl ?? defaultGiteaUrl();
  await waitForGitea(giteaUrl);

  // Technical admin.
  const adminUser = opts.adminUser ?? previous?.admin.username ?? DEFAULT_ADMIN;
  const keepAdmin = previous?.admin.username === adminUser ? previous.admin : undefined;
  const adminPassword = keepAdmin?.password ?? randomBytes(18).toString('base64url');
  await ensureUser(adminUser, `${adminUser}@slipway.local`, adminPassword, true);
  const adminToken = await tokenFor(giteaUrl, { username: adminUser, password: adminPassword }, keepAdmin?.token, 'slipway-admin');
  const adminApi = new GiteaClient(giteaUrl, adminToken);

  // Your login: a plain reviewer.
  const { username: reviewerUser, password: reviewerPassword } = resolveOwnerCredentials(opts, previous ? { owner: previous.reviewer } : undefined);
  await ensureUser(reviewerUser, opts.ownerEmail ?? `${reviewerUser}@slipway.local`, reviewerPassword, false);
  const reviewerToken = await tokenFor(
    giteaUrl, { username: reviewerUser, password: reviewerPassword },
    previous?.reviewer.username === reviewerUser ? previous.reviewer.token : undefined, 'slipway-reviewer',
  );

  // The org that owns the review repos.
  const org = opts.org ?? previous?.org ?? DEFAULT_ORG;
  try {
    await adminApi.createOrg(org);
    log(`created organization ${org}`);
  } catch (e) {
    if (!(e instanceof GiteaError && (e.status === 409 || e.status === 422))) throw e;
  }

  // Your login is a member of the org through a write team covering all its repos: /<org> and the repo list work,
  // and new repos are included automatically. Write, not admin: still no Settings.
  if (reviewerUser !== adminUser) {
    const team = (await adminApi.listTeams(org)).find((t) => t.name === REVIEWERS_TEAM) ?? (await adminApi.createTeam(org, REVIEWERS_TEAM));
    await adminApi.addTeamMember(team.id, reviewerUser);
  }

  const claude = await keepValidClaude(previous?.claude, (a) => tokenWorks(giteaUrl, a.token, a.username));
  const config: SlipwayConfig = {
    giteaUrl,
    admin: { username: adminUser, password: adminPassword, token: adminToken },
    reviewer: { username: reviewerUser, password: reviewerPassword, token: reviewerToken },
    org,
    ...(claude ? { claude } : {}),
    repos: previous?.repos ?? {},
  };

  // Move repos that are not in the org yet (an org rename), keeping PRs and reviews.
  for (const [name, entry] of Object.entries(config.repos)) {
    const inOrg = await adminApi.getRepo(org, name).then(() => true, (e) => (e instanceof GiteaError && e.status === 404 ? false : Promise.reject(e)));
    if (!inOrg) {
      const from = previous?.org ?? reviewerUser;
      await adminApi.transferRepo(from, name, org);
      log(`moved ${from}/${name} → ${org}/${name}`);
    }
    await applyRepoAccess(config, name, entry.base);
    if (existsSync(entry.path)) await setReviewRemote(config, name, entry.path);
  }

  // Your login is never a Gitea admin (no repo Settings, no site administration).
  await adminApi.adminEditUser(reviewerUser, { admin: false });
  saveConfig(config);
  return config;
}
