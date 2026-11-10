/**
 * A small POSIX-shell reader for the guard hook: splits a Bash command into simple commands with their words unquoted,
 * keeps heredoc bodies apart (they are data, not commands), drops redirections and command prefixes, and reads into
 * `bash -c '…'` and heredocs fed to a shell (`bash <<'EOF'`). It is a best-effort reader for spotting habits, not a full shell parser (ADR 0013).
 */
export interface SimpleCommand {
  /** Words with quotes removed, without leading assignments, prefixes (`env`, `command`, `!`…) and redirections. */
  words: string[];
  /** Bodies of the heredocs this command reads, in order. */
  heredocs: string[];
  /** Redirection targets (`< in`, `> out`, `2>log`), unquoted. */
  redirects: string[];
}

const PREFIXES = new Set(['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'builtin',
  'exec', 'nohup', 'env', 'sudo']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A redirection word: `>f`, `2>>f`, `&>f`, `>&2`, `2>&1`, `<f` (the target may be the next word). */
const REDIRECT = /^(\d*|&)(>>?|<>?|>&|<&)(.*)$/;

interface Raw { words: string[]; quoted: boolean[]; heredocs: string[]; pending: Array<{ delim: string; strip: boolean }> }

export function parseCommand(command: string, depth = 0): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const raws: Raw[] = [];
  let cur: Raw = { words: [], quoted: [], heredocs: [], pending: [] };
  const queue: Raw[] = []; // commands with heredocs still to read, in declaration order
  let word: string | null = null;
  let quoted = false;
  const endWord = () => {
    if (word !== null) { cur.words.push(word); cur.quoted.push(quoted); }
    word = null;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (cur.words.length || cur.heredocs.length) raws.push(cur);
    if (cur.pending.length) queue.push(cur);
    cur = { words: [], quoted: [], heredocs: [], pending: [] };
  };
  const add = (s: string) => { word = (word ?? '') + s; };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i]!;
    if (c === '\n') {
      endCommand();
      i++;
      // Read the bodies of every heredoc opened on the line that just ended.
      while (queue.length) {
        const owner = queue[0]!;
        const h = owner.pending.shift()!;
        if (!owner.pending.length) queue.shift();
        const lines: string[] = [];
        while (i < n) {
          let e = command.indexOf('\n', i);
          if (e < 0) e = n;
          const line = command.slice(i, e);
          i = e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        owner.heredocs.push(lines.join('\n'));
      }
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && word === null) { // comment to the end of the line
      while (i < n && command[i] !== '\n') i++;
      continue;
    }
    if (c === '\\') {
      if (command[i + 1] === '\n') { i += 2; continue; }
      add(command[i + 1] ?? '');
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = command.indexOf("'", i + 1);
      add(command.slice(i + 1, e < 0 ? n : e));
      quoted = true;
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && '"\\$`\n'.includes(command[j + 1] ?? '')) {
          if (command[j + 1] !== '\n') s += command[j + 1];
          j += 2;
        } else if (command[j] === '$' && command[j + 1] === '(') { // `"$(cat <<'EOF' … EOF)"`: quotes inside do not end the word
          const e = substitutionEnd(command, j);
          s += command.slice(j, e + 1);
          j = e + 1;
        } else if (command[j] === '`') {
          const e = backquoteEnd(command, j);
          s += command.slice(j, e + 1);
          j = e + 1;
        } else {
          s += command[j];
          j++;
        }
      }
      add(s);
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') { // command substitution: kept inside the word
      const e = substitutionEnd(command, i);
      add(command.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    if (c === '`') {
      const e = backquoteEnd(command, i);
      add(command.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    if (command.startsWith('<<<', i)) { // here-string: its own word, so the data after it is not read as a heredoc
      endWord();
      add('<<<');
      endWord();
      i += 3;
      continue;
    }
    if (c === '<' && command[i + 1] === '<') { // heredoc
      endWord();
      let j = i + 2;
      const strip = command[j] === '-';
      if (strip) j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      const [delim, e] = heredocDelimiter(command, j);
      if (delim) cur.pending.push({ delim, strip });
      i = e;
      continue;
    }
    if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) { add(c); i++; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endCommand();
      i++;
      continue;
    }
    add(c);
    i++;
  }
  endCommand();
  for (const h of queue) for (const _ of h.pending) h.heredocs.push(''); // unterminated heredoc

  for (const r of raws) {
    const words: string[] = [];
    const redirects: string[] = [];
    for (let k = 0; k < r.words.length; k++) {
      const w = r.words[k]!;
      if (r.quoted[k]) { words.push(w); continue; }
      if (w.startsWith('<<<')) { if (w === '<<<') k++; continue; } // here-string: its data is not a word of the command
      const m = REDIRECT.exec(w);
      if (m && (m[1] !== '' || w.startsWith('>') || w.startsWith('<'))) {
        if (m[3] === '' && !/&$/.test(m[2]!)) { // `> file`: the target is the next word
          if (r.words[k + 1] !== undefined) redirects.push(r.words[k + 1]!);
          k++;
        } else if (m[3] && !m[3].startsWith('&')) {
          redirects.push(m[3]);
        }
        continue;
      }
      words.push(w);
    }
    // Leading assignments and prefixes (`FOO=1 env BAR=2 command git push` → `git push`).
    let s = 0;
    while (s < words.length && (ASSIGNMENT.test(words[s]!) || PREFIXES.has(words[s]!) || (words[s] === '-i' && words[s - 1] === 'env'))) s++;
    const w = words.slice(s);
    if (!w.length && !r.heredocs.length && !redirects.length) continue;
    out.push({ words: w, heredocs: r.heredocs, redirects });
    const exe = (w[0] ?? '').split('/').pop()!;
    if (SHELLS.has(exe) && depth < 3) {
      const ci = w.findIndex((a, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (ci > 0 && w[ci + 1] !== undefined) out.push(...parseCommand(w[ci + 1]!, depth + 1));
      else for (const h of r.heredocs) out.push(...parseCommand(h, depth + 1)); // `bash <<'EOF'`: the shell runs the body
    }
  }
  return out;
}

/** Reads a heredoc delimiter word starting at `j` (quotes removed); returns it and the index after it. */
function heredocDelimiter(command: string, j: number): [string, number] {
  const n = command.length;
  let delim = '';
  while (j < n && !' \t\n;&|<>()'.includes(command[j]!)) {
    const q = command[j]!;
    if (q === "'" || q === '"') {
      const e = command.indexOf(q, j + 1);
      delim += command.slice(j + 1, e < 0 ? n : e);
      j = e < 0 ? n : e + 1;
    } else {
      if (q !== '\\') delim += q;
      j++;
    }
  }
  return [delim, j];
}

/** Index of the backquote that closes the one at `i` (or the last index). */
function backquoteEnd(command: string, i: number): number {
  for (let j = i + 1; j < command.length; j++) {
    if (command[j] === '\\') j++;
    else if (command[j] === '`') return j;
  }
  return command.length - 1;
}

/** Index of the end of a double-quoted string opened at `i` (its closing quote, or the last index). */
function doubleQuoteEnd(command: string, i: number): number {
  for (let j = i + 1; j < command.length; j++) {
    const c = command[j];
    if (c === '\\') j++;
    else if (c === '"') return j;
    else if (c === '$' && command[j + 1] === '(') j = substitutionEnd(command, j);
    else if (c === '`') j = backquoteEnd(command, j);
  }
  return command.length - 1;
}

/**
 * Index of the `)` that closes the command substitution `$(` at `i` (or the last index). Quotes, nested substitutions and
 * heredoc bodies inside it are skipped, so a `"` or `)` in a commit message written through `"$(cat <<'EOF' … EOF)"` does
 * not end it early.
 */
export function substitutionEnd(command: string, i: number): number {
  const n = command.length;
  const pending: Array<{ delim: string; strip: boolean }> = [];
  let depth = 0;
  for (let j = i + 1; j < n; j++) {
    const c = command[j]!;
    if (c === '\\') { j++; continue; }
    if (c === "'") { const e = command.indexOf("'", j + 1); if (e < 0) return n - 1; j = e; continue; }
    if (c === '"') { j = doubleQuoteEnd(command, j); continue; }
    if (c === '`') { j = backquoteEnd(command, j); continue; }
    if (c === '#' && /[\s(;&|]/.test(command[j - 1] ?? ' ')) { // comment to the end of the line
      while (j + 1 < n && command[j + 1] !== '\n') j++;
      continue;
    }
    if (c === '<' && command[j + 1] === '<' && command[j + 2] !== '<') {
      let k = j + 2;
      const strip = command[k] === '-';
      if (strip) k++;
      while (command[k] === ' ' || command[k] === '\t') k++;
      const [delim, e] = heredocDelimiter(command, k);
      if (delim) pending.push({ delim, strip });
      j = e - 1;
      continue;
    }
    if (c === '<' && command.startsWith('<<<', j)) { j += 2; continue; }
    if (c === '\n' && pending.length) { // skip the bodies of the heredocs opened on this line
      let k = j + 1;
      for (const h of pending.splice(0)) {
        while (k < n) {
          let e = command.indexOf('\n', k);
          if (e < 0) e = n;
          const line = command.slice(k, e);
          k = e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      j = k - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return n - 1;
}
