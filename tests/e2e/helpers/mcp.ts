import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { E2E, e2eEnv, ROOT } from './env.ts';
import { AGENT_ID } from './slipway.ts';

export interface ToolCall { text: string; isError: boolean }

/** Plays Claude: an MCP client talking to the bundled plugin server, like Claude Code does. */
export class FakeClaude {
  private client = new Client({ name: 'e2e-claude', version: '1' });

  static async start(cwd: string): Promise<FakeClaude> {
    const c = new FakeClaude();
    const { mockUrl } = JSON.parse(readFileSync(E2E.stateFile, 'utf8'));
    const env = e2eEnv({
      ...AGENT_ID,
      PATH: `${E2E.fakeBin}:${process.env.PATH}`,
      SLIPWAY_GITHUB_API: mockUrl,
      SLIPWAY_CLAUDE_USER: E2E.claudeUser,
    });
    delete env.SLIPWAY_GITHUB_TOKEN; // the token must come from `gh auth token`
    await c.client.connect(new StdioClientTransport({
      command: 'node',
      args: [join(ROOT, 'plugin', 'dist', 'slipway-mcp.mjs')],
      cwd,
      env: env as Record<string, string>,
      stderr: 'pipe',
    }));
    return c;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const r: any = await this.client.callTool({ name, arguments: args });
    return { text: r.content?.[0]?.text ?? '', isError: !!r.isError };
  }

  async ok(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.text;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
