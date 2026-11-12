import { hostname } from 'node:os';
import { loadConfig, saveConfig } from '../config.ts';
import { slipwayEnv } from '../env.ts';
import { claudeUsername, ensureClaudeUser, giteaAdmin } from '../mcp/enroll.ts';
import { giteaHealthy } from '../runtime/health.ts';
import { defaultGitleaks, defaultSbx, prepareSandbox } from './setup.ts';

export function runSbxSetup(name: string, log: (m: string) => void): Promise<void> {
  return prepareSandbox(name, {
    sbx: defaultSbx,
    loadConfig,
    healthy: giteaHealthy,
    claudeAccount: (config) => ensureClaudeUser(config, {
      admin: giteaAdmin(config), save: saveConfig, reload: loadConfig, username: claudeUsername(hostname(), slipwayEnv('CLAUDE_USER')),
    }),
    gitleaks: defaultGitleaks,
    log,
  });
}
