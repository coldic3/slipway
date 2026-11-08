import { basename, resolve } from 'node:path';
import { loadConfig, saveConfig, type SlipwayConfig } from '../config.ts';
import { GiteaClient, GiteaError } from '../gitea/client.ts';
import { git, run } from '../util/exec.ts';
import { parseGitHubRemote } from '../util/git-auth.ts';
import { syncMain } from './sync.ts';

export interface AddRepoOptions {
  path: string;
  name?: string;
  github?: string;
  base?: string;
  log?: (msg: string) => void;
}

export function giteaRemoteUrl(config: SlipwayConfig, name: string): string {
  return `${config.giteaUrl.replace(/\/$/, '')}/${config.org}/${name}.git`;
}

/** Repo settings that make merging in Gitea impossible (security invariant). */
export const NO_MERGE_SETTINGS = {
  allow_merge_commits: false,
  allow_rebase: false,
  allow_rebase_explicit: false,
  allow_squash_merge: false,
  allow_fast_forward_only_merge: false,
  allow_manual_merge: false,
  autodetect_manual_merge: false,
  has_wiki: false,
  has_projects: false,
  has_releases: false,
  has_packages: false,
  has_actions: false,
};

/** Branch protection: only Slipway's admin may push the base (sync-main); nobody may merge. */
export function protectionFor(base: string, admin: string) {
  return {
    rule_name: base,
    branch_name: base,
    enable_push: true,
    enable_push_whitelist: true,
    push_whitelist_usernames: [admin],
    enable_force_push: true,
    enable_force_push_allowlist: true,
    force_push_allowlist_usernames: [admin],
    enable_merge_whitelist: true,
    merge_whitelist_usernames: [],
    block_admin_merge_override: true,
    block_on_rejected_reviews: true,
  };
}

/**
 * Settings, access and protection of a review repo in the org (ADR 0005): no merging, the reviewer and Claude get write
 * access (no repo admin, so no Settings), only Slipway's admin can push the base. Idempotent.
 */
export async function applyRepoAccess(config: SlipwayConfig, name: string, base: string): Promise<void> {
  const admin = new GiteaClient(config.giteaUrl, config.admin.token);
  await admin.editRepo(config.org, name, { ...NO_MERGE_SETTINGS, default_branch: base });
  if (config.reviewer.username !== config.admin.username) await admin.addCollaborator(config.org, name, config.reviewer.username, 'write');
  if (config.claude) await admin.addCollaborator(config.org, name, config.claude.username, 'write');
  const protections = await admin.listBranchProtections(config.org, name).catch(() => []);
  if (protections.some((p) => p.rule_name === base)) await admin.editBranchProtection(config.org, name, base, protectionFor(base, config.admin.username));
  else await admin.createBranchProtection(config.org, name, protectionFor(base, config.admin.username));
}

/** Points the clone's "review" remote at the repo in the org. */
export async function setReviewRemote(config: SlipwayConfig, name: string, clonePath: string): Promise<void> {
  const url = giteaRemoteUrl(config, name);
  const hasReview = (await run('git', ['remote', 'get-url', 'review'], { cwd: clonePath })).code === 0;
  await git(clonePath, hasReview ? ['remote', 'set-url', 'review', url] : ['remote', 'add', 'review', url]);
}

export async function addRepo(opts: AddRepoOptions): Promise<{ name: string; url: string }> {
  const log = opts.log ?? (() => {});
  const config = loadConfig();
  const path = resolve(opts.path);
  const top = await git(path, ['rev-parse', '--show-toplevel']);
  const name = opts.name ?? basename(top);
  const base = opts.base ?? 'main';
  let github = opts.github;
  if (!github) {
    const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: top });
    github = parseGitHubRemote(origin.stdout) ?? undefined;
    if (!github) throw new Error('Cannot infer the GitHub repo from remote "origin"; pass --github owner/name');
  }
  const admin = new GiteaClient(config.giteaUrl, config.admin.token);
  try {
    await admin.createOrgRepo(config.org, name, `Slipway review station for ${github}`);
    log(`created Gitea repo ${config.org}/${name}`);
  } catch (e) {
    if (!(e instanceof GiteaError && e.status === 409)) throw e;
    log(`Gitea repo ${config.org}/${name} already exists`);
  }
  // Local clone: a "review" remote for humans (fetching, inspecting). Claude pushes through the plugin.
  await setReviewRemote(config, name, top);
  config.repos[name] = { path: top, base, github };
  saveConfig(config);
  // The base branch must exist before branch protection; sync-main pushes it as the admin.
  await syncMain(name);
  await applyRepoAccess(config, name, base);
  return { name, url: giteaRemoteUrl(config, name) };
}
