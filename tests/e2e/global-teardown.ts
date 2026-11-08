import { join } from 'node:path';
import { run } from '../../src/util/exec.ts';
import { e2eEnv, ROOT } from './helpers/env.ts';

export default async function globalTeardown(): Promise<void> {
  if (process.env.SLIPWAY_E2E_KEEP === '1') return; // keep the stack for debugging
  await run(join(ROOT, 'bin', 'slipway'), ['down', '--purge'], { env: e2eEnv() });
}
