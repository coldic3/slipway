import { describe, expect, it } from 'vitest';
import { basicAuthArgs, parseGitHubRemote } from '../../src/util/git-auth.ts';

describe('git auth helpers', () => {
  it('builds a per-command basic auth header', () => {
    expect(basicAuthArgs('u', 't')).toEqual(['-c', `http.extraHeader=Authorization: Basic ${Buffer.from('u:t').toString('base64')}`]);
  });
  it('parses GitHub remotes', () => {
    expect(parseGitHubRemote('git@github.com:kevin/demo.git')).toBe('kevin/demo');
    expect(parseGitHubRemote('https://github.com/kevin/demo')).toBe('kevin/demo');
    expect(parseGitHubRemote('https://github.com/kevin/demo.git')).toBe('kevin/demo');
    expect(parseGitHubRemote('/tmp/origin.git')).toBeNull();
  });
});
