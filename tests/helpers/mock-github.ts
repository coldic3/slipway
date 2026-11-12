import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface MockPull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  state: 'open' | 'closed';
  html_url: string;
  merged_at?: string | null;
}

/** Minimal in-memory GitHub REST API: list/create/update pulls. */
export class MockGitHub {
  requests: RecordedRequest[] = [];
  pulls: MockPull[] = [];
  private server?: Server;
  url = '';

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      this.requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const u = new URL(req.url!, 'http://x');
      const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/.exec(u.pathname);
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      // Test-only inspection endpoints (no auth).
      if (u.pathname === '/__state') return send(200, { pulls: this.pulls, requests: this.requests.filter((r) => !r.url.startsWith('/__')) });
      if (!req.headers.authorization?.startsWith('Bearer ')) return send(401, { message: 'Bad credentials' });
      if (!m) return send(404, { message: 'Not Found' });
      const [, owner, repo, num] = m;
      const toApi = (p: MockPull) => ({ ...p, head: { ref: p.head, label: `${owner}:${p.head}` }, base: { ref: p.base } });
      if (req.method === 'GET' && !num) {
        const head = u.searchParams.get('head')?.split(':')[1];
        const state = u.searchParams.get('state') ?? 'open';
        return send(200, this.pulls.filter((p) => (!head || p.head === head) && (state === 'all' || p.state === state)).map(toApi));
      }
      if (req.method === 'POST' && !num) {
        if (this.pulls.some((p) => p.head === body.head && p.state === 'open')) return send(422, { message: 'A pull request already exists' });
        const n = this.pulls.length + 1;
        const p: MockPull = { number: n, head: body.head, base: body.base, title: body.title, body: body.body, draft: !!body.draft, state: 'open', html_url: `https://github.com/${owner}/${repo}/pull/${n}` };
        this.pulls.push(p);
        return send(201, toApi(p));
      }
      if (req.method === 'PATCH' && num) {
        const p = this.pulls.find((x) => x.number === Number(num));
        if (!p) return send(404, { message: 'Not Found' });
        Object.assign(p, Object.fromEntries(Object.entries(body).filter(([k]) => ['title', 'body', 'base', 'state'].includes(k))));
        return send(200, toApi(p));
      }
      return send(405, { message: 'unsupported' });
    });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    this.url = `http://${host}:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
