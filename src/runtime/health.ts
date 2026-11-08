export async function giteaHealthy(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function waitForGitea(url: string, timeoutMs = 60_000, failed: () => string | undefined = () => undefined): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    const why = failed();
    if (why) throw new Error(why);
    try {
      const r = await fetch(`${url}/api/healthz`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Gitea at ${url} did not become ready: ${last}`);
}
