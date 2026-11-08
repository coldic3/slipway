import { connect, createServer } from 'node:net';

/** True when nothing listens on 127.0.0.1:<port> and we could bind it. */
export async function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  // Something answering a connect is "taken", even if a bind would succeed (e.g. a 0.0.0.0 listener on macOS).
  const answers = await new Promise<boolean>((resolve) => {
    const s = connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
  if (answers) return false;
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export async function nextFreePort(from: number, tries = 100, free: (p: number) => Promise<boolean> = portFree): Promise<number | undefined> {
  for (let p = from; p < from + tries && p <= 65535; p++) if (await free(p)) return p;
  return undefined;
}

export class PortBusyError extends Error {
  constructor(public readonly port: number, public readonly suggestion?: number) {
    super(
      `port ${port} is already in use by another program, so Slipway cannot start there.\n` +
        (suggestion
          ? `Start it on a free port instead (Slipway remembers it for later runs):\n  slipway up --port ${suggestion}`
          : 'Pick a free port with: slipway up --port <port>') +
        '\nor set SLIPWAY_PORT.',
    );
  }
}
