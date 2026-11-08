import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectConventions, FALLBACK_TEMPLATE } from '../../src/mcp/conventions.ts';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dd-conv-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

describe('collectConventions', () => {
  it('collects template, contributing, agent rules, commitlint and PR-title CI checks', () => {
    const dir = repo({
      '.github/pull_request_template.md': '## Summary\n## Ticket',
      'CONTRIBUTING.md': 'PR titles must reference a JIRA key',
      'CLAUDE.md': 'Use conventional commits',
      'commitlint.config.js': "module.exports = { extends: ['@commitlint/config-conventional'] }",
      '.github/workflows/pr-title.yml': 'uses: amannn/action-semantic-pull-request@v5',
      '.github/workflows/build.yml': 'run: npm test',
    });
    const c = collectConventions(dir);
    const sources = c.items.map((i) => i.source);
    expect(sources).toEqual(expect.arrayContaining(['.github/pull_request_template.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'commitlint.config.js', '.github/workflows/pr-title.yml']));
    expect(sources).not.toContain('.github/workflows/build.yml');
    expect(c.usedFallbackTemplate).toBe(false);
  });

  it('finds templates in other places and in a template directory', () => {
    const c = collectConventions(repo({ '.github/PULL_REQUEST_TEMPLATE/feature.md': 'F', 'docs/PULL_REQUEST_TEMPLATE.md': 'D' }));
    expect(c.items.map((i) => i.source)).toEqual(expect.arrayContaining(['.github/PULL_REQUEST_TEMPLATE/feature.md', 'docs/PULL_REQUEST_TEMPLATE.md']));
  });

  it('collects branch-naming rules from CI checks and git hooks, not unrelated workflows (ADR 0010)', () => {
    const c = collectConventions(repo({
      '.github/workflows/branch.yml': 'uses: deepakputhraya/action-branch-name@master\nwith:\n  regex: ^(feature|fix)/',
      '.github/workflows/ci.yml': 'concurrency: ${{ github.head_ref || github.run_id }}\nrun: npm test',
      '.husky/pre-push': 'npx validate-branch-name',
      '.husky/pre-commit': 'npx lint-staged',
      'lefthook.yml': 'pre-push:\n  commands:\n    branch: { run: ./check-branch.sh }',
    }));
    const sources = c.items.map((i) => i.source);
    expect(sources).toEqual(expect.arrayContaining(['.github/workflows/branch.yml', '.husky/pre-push', 'lefthook.yml']));
    expect(sources).not.toContain('.github/workflows/ci.yml');
    expect(sources).not.toContain('.husky/pre-commit');
  });

  it('falls back to the Slipway template', () => {
    const c = collectConventions(repo({ 'README.md': 'x' }));
    expect(c.usedFallbackTemplate).toBe(true);
    expect(c.items[0]).toEqual({ source: 'slipway default template', content: FALLBACK_TEMPLATE });
  });

  it('truncates huge files', () => {
    const c = collectConventions(repo({ 'CLAUDE.md': 'x'.repeat(50_000) }));
    expect(c.items.find((i) => i.source === 'CLAUDE.md')!.content.length).toBeLessThan(21_000);
  });
});
