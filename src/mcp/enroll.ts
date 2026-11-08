import { randomBytes } from 'node:crypto';
import type { Account, SlipwayConfig } from '../config.ts';
import { GiteaClient, GiteaError } from '../gitea/client.ts';

export const CLAUDE_TOKEN_SCOPES = ['write:repository', 'write:issue', 'read:user'];

/** The admin operations enrollment needs (Slipway's technical admin token). */
export interface GiteaAdminPort {
  createUser(username: string, email: string, password: string): Promise<void>;
  resetPassword(username: string, password: string): Promise<void>;
  /** Creates a token for the user, authenticating as that user. */
  createToken(username: string, password: string, name: string, scopes: string[]): Promise<string>;
  addCollaborator(owner: string, repo: string, username: string): Promise<void>;
}

export function claudeUsername(hostname: string, override?: string): string {
  if (override) return override;
  const slug = hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `claude-${slug}`.slice(0, 40).replace(/-+$/, '');
}

let pending: Promise<Account> | undefined;

/** Test hook: forget an in-flight/finished enrollment. */
export function resetEnrollmentCache(): void {
  pending = undefined;
}

/**
 * Returns this Claude install's Gitea account, creating it on first use with Slipway's technical admin
 * (threat model: mistakes, not malice; ADR 0003). Concurrent callers share one enrollment.
 */
export function ensureClaudeUser(
  config: SlipwayConfig,
  deps: EnrollDeps,
): Promise<Account> {
  if (config.claude) return Promise.resolve(config.claude);
  pending ??= enroll(config, deps).catch((e) => {
    pending = undefined;
    throw e;
  });
  return pending;
}

export interface EnrollDeps {
  admin: GiteaAdminPort;
  save: (c: SlipwayConfig) => void;
  username: string;
  /** Re-reads the config right before saving, so concurrent changes (repo add, another session) are kept. */
  reload?: () => SlipwayConfig;
}

async function enroll(config: SlipwayConfig, deps: EnrollDeps): Promise<Account> {
  const { admin, username } = deps;
  const password = randomBytes(18).toString('base64url');
  try {
    await admin.createUser(username, `${username}@slipway.local`, password);
  } catch (e) {
    if (!(e instanceof GiteaError && e.status === 422)) throw e;
    await admin.resetPassword(username, password);
  }
  // A unique token name: a parallel enrollment (another Claude session) never deletes the token we save.
  const tokenName = `slipway-claude-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const token = await admin.createToken(username, password, tokenName, CLAUDE_TOKEN_SCOPES);
  for (const repo of Object.keys(config.repos)) await admin.addCollaborator(config.org, repo, username);
  const account: Account = { username, password, token };
  config.claude = account;
  const fresh = deps.reload?.() ?? config;
  fresh.claude = account;
  deps.save(fresh);
  return account;
}

/** Production admin port over the Gitea API. */
export function giteaAdmin(config: SlipwayConfig): GiteaAdminPort {
  const owner = new GiteaClient(config.giteaUrl, config.admin.token);
  return {
    async createUser(username, email, password) {
      await owner.adminCreateUser({ username, email, password });
    },
    async resetPassword(username, password) {
      await owner.adminEditUser(username, { password });
    },
    createToken(username, password, name, scopes) {
      return new GiteaClient(config.giteaUrl, { basic: [username, password] }).createToken(username, name, scopes);
    },
    async addCollaborator(ownerName, repo, user) {
      await owner.addCollaborator(ownerName, repo, user, 'write');
    },
  };
}
