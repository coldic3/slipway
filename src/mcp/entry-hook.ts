import { main } from './hook.ts';

main().catch(() => process.exit(0)); // a broken hook must never block the session
