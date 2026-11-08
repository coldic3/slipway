import { startServer } from './server.ts';

startServer().catch((e) => {
  console.error(`slipway-mcp: ${(e as Error).message}`);
  process.exit(1);
});
