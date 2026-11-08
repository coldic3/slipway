import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { nextFreePort, portFree, PortBusyError } from '../../src/runtime/port.ts';

describe('port probing', () => {
  it('sees a port taken by another program and finds the next free one', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await portFree(port)).toBe(false);
      const next = await nextFreePort(port);
      expect(next).toBeGreaterThan(port);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await portFree(port)).toBe(true);
  });

  it('the busy-port error names the exact command', () => {
    expect(new PortBusyError(3514, 3515).message).toMatch(/port 3514 is already in use[\s\S]*slipway up --port 3515[\s\S]*SLIPWAY_PORT/);
  });
});
