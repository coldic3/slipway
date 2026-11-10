import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/mcp/shell.ts';

const words = (c: string) => parseCommand(c).map((x) => x.words);

describe('parseCommand', () => {
  it('splits on operators outside quotes and unquotes words', () => {
    expect(words(`git commit -m "a; b && c" && git push origin 'x y'`)).toEqual([['git', 'commit', '-m', 'a; b && c'], ['git', 'push', 'origin', 'x y']]);
    expect(words('a | b || c; d & e')).toEqual([['a'], ['b'], ['c'], ['d'], ['e']]);
    expect(words('(cd sub && git push)')).toEqual([['cd', 'sub'], ['git', 'push']]);
    expect(words('a\\ b "c\\"d" e\\\nf')).toEqual([['a b', 'c"d', 'ef']]);
  });

  it('keeps heredoc bodies as data of the command that reads them', () => {
    const cmds = parseCommand("cat > f <<'EOF' && echo ok\ngit push\nEOF\ngit status");
    expect(cmds.map((c) => c.words)).toEqual([['cat'], ['echo', 'ok'], ['git', 'status']]);
    expect(cmds[0]!.heredocs).toEqual(['git push']);
    expect(cmds[0]!.redirects).toEqual(['f']);
    expect(parseCommand('cat <<-X\n\tbody\n\tX\nls')[0]!.heredocs).toEqual(['\tbody']);
    expect(parseCommand('cat <<A <<B\na\nA\nb\nB')[0]!.heredocs).toEqual(['a', 'b']);
  });

  it('drops redirections, comments, assignments and prefixes', () => {
    expect(words('FOO=1 env BAR=2 command git push origin x 2>&1 >/dev/null')).toEqual([['git', 'push', 'origin', 'x']]);
    expect(words('git push > out.log # git push --tags')).toEqual([['git', 'push']]);
    expect(words('if true; then git push; fi')).toEqual([['true'], ['git', 'push'], ['fi']]);
    expect(words('cat <<< "git push"')).toEqual([['cat']]);
    expect(parseCommand('node x.js < in.json 2>err.log')[0]!.redirects).toEqual(['in.json', 'err.log']);
  });

  it('keeps command substitutions inside their word and reads into sh -c', () => {
    expect(words('echo "$(git push; ls)" `git push`')).toEqual([['echo', '$(git push; ls)', '`git push`']]);
    expect(words(`bash -lc 'cd x && git push origin main'`)).toEqual([['bash', '-lc', 'cd x && git push origin main'], ['cd', 'x'], ['git', 'push', 'origin', 'main']]);
  });
});

describe('parseCommand: command substitutions in double quotes', () => {
  it('quotes, parentheses and heredoc bodies inside "$(…)" do not end the word', () => {
    const body = "$(cat <<'EOF'\nfix: say \"hi\ngit push origin main\n) it's\nEOF\n)";
    expect(words(`git commit -m "${body}" && git push`)).toEqual([['git', 'commit', '-m', body], ['git', 'push']]);
    expect(words('echo "a `b "c"` d" && ls')).toEqual([['echo', 'a `b "c"` d'], ['ls']]);
    expect(words('echo $(printf "%s)" x) && ls')).toEqual([['echo', '$(printf "%s)" x)'], ['ls']]);
  });
});

describe('parseCommand: shells and here-strings', () => {
  it('reads heredocs fed to a shell, but not those fed to other commands', () => {
    expect(words("bash <<'EOF'\ncd x && git push\nEOF")).toEqual([['bash'], ['cd', 'x'], ['git', 'push']]);
    expect(words("sh -c 'ls' <<'EOF'\ngit push\nEOF")).toEqual([['sh', '-c', 'ls'], ['ls']]); // -c wins, stdin is data
    expect(words("cat <<'EOF'\ngit push\nEOF")).toEqual([['cat']]);
  });

  it('a here-string is one word of data, not the start of a heredoc', () => {
    expect(words('cat <<< "x"\ngit push\nx')).toEqual([['cat'], ['git', 'push'], ['x']]);
    expect(words('cat <<<"$v" && git push')).toEqual([['cat'], ['git', 'push']]);
  });
});
