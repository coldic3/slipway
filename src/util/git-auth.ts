/**
 * Per-command HTTP auth for git: returns `-c http.extraHeader=...` args.
 * The credential never lands in .git/config or in the remote URL.
 */
export function basicAuthArgs(user: string, token: string): string[] {
  const b64 = Buffer.from(`${user}:${token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${b64}`];
}

export function bearerAuthArgs(urlPrefix: string, token: string): string[] {
  // GitHub accepts basic auth with x-access-token:<token>; scope the header to the URL prefix.
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.${urlPrefix}.extraHeader=Authorization: Basic ${b64}`];
}

/** Parses owner/name from a GitHub remote URL (https or ssh). */
export function parseGitHubRemote(url: string): string | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
