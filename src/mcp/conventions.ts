import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FALLBACK_TEMPLATE = `## Context

<!-- Task / issue this PR solves and why. Link the task id. -->

## What changed

<!-- Bullet list of the changes, grouped by area. -->

## How it was tested

<!-- Commands run, tests added, manual checks. -->

## Open questions

<!-- Anything the reviewer should decide. Write "None" if there are none. -->
`;

const MAX = 20_000;
const TEMPLATE_FILES = ['pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md'];
const TEMPLATE_DIRS = ['.github', '.gitea', 'docs', ''];

export interface ConventionItem { source: string; content: string }
export interface Conventions { items: ConventionItem[]; usedFallbackTemplate: boolean }

const PR_TITLE_CHECK = /semantic-pull-request|pr[-_]title|pull_request_title|github\.event\.pull_request\.title/i;
// Branch-name checks (e.g. action-branch-name, branchlint, validate-branch-name). Not head_ref alone: it is common in concurrency groups.
const BRANCH_CHECK = /branch[-_ ]?nam(e|ing)|branchlint|validate[-_]branch/i;

/** Raw PR and branch-naming rules of a repository, with their sources. Interpretation is left to the model (skills). */
export function collectConventions(root: string): Conventions {
  const items: ConventionItem[] = [];
  const add = (rel: string) => {
    const p = join(root, rel);
    if (!existsSync(p) || !statSync(p).isFile() || items.some((i) => i.source === rel)) return;
    let content = readFileSync(p, 'utf8');
    if (content.length > MAX) content = content.slice(0, MAX) + '\n…(truncated)';
    items.push({ source: rel, content });
  };
  const list = (rel: string) => {
    const p = join(root, rel);
    return existsSync(p) && statSync(p).isDirectory() ? readdirSync(p) : [];
  };

  for (const dir of TEMPLATE_DIRS) {
    for (const f of list(dir || '.')) if (TEMPLATE_FILES.some((t) => t.toLowerCase() === f.toLowerCase())) add(join(dir, f));
    for (const tdir of list(dir || '.').filter((d) => d.toLowerCase() === 'pull_request_template')) {
      for (const f of list(join(dir, tdir))) if (f.endsWith('.md')) add(join(dir, tdir, f));
    }
  }
  const hasTemplate = items.length > 0;
  for (const rel of ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md']) add(rel);
  for (const f of list('.')) if (/^(commitlint\.config\.[cm]?[jt]s|\.commitlintrc.*)$/.test(f)) add(f);
  for (const f of list('.github/workflows')) {
    const rel = join('.github/workflows', f);
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readFileSync(join(root, rel), 'utf8');
    if (PR_TITLE_CHECK.test(text) || BRANCH_CHECK.test(text)) add(rel);
  }
  // Git hooks that check branch names locally (husky, lefthook, pre-commit).
  const hookFiles = [...list('.husky').map((f) => join('.husky', f)), ...list('.').filter((f) => /^(lefthook\.ya?ml|\.lefthook\.ya?ml|\.pre-commit-config\.yaml)$/.test(f))];
  for (const rel of hookFiles) {
    const p = join(root, rel);
    if (statSync(p).isFile() && /branch/i.test(readFileSync(p, 'utf8'))) add(rel);
  }
  if (!hasTemplate) items.unshift({ source: 'slipway default template', content: FALLBACK_TEMPLATE });
  return { items, usedFallbackTemplate: !hasTemplate };
}
