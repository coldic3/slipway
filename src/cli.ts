import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ghLoggedIn, init, initSummary, repoHere, terminalAsk } from './init.ts';
import { loadConfig } from './config.ts';
import { down, status, up } from './runtime/index.ts';
import { bootstrap } from './setup/bootstrap.ts';
import { addRepo } from './setup/repo.ts';
import { syncMain } from './setup/sync.ts';
import { VERSION } from './version.ts';

const HELP = `slipway ${VERSION}: a local review station for AI-agent PRs (Gitea → GitHub)

Start here:
  slipway init [--agent claude-code|none] [--port 3514] [--docker] [--yes]
                                     set everything up: the server, your login, your agent's plugin, this repo

Server:
  slipway up [--port N] [--docker]   start Slipway's Gitea on 127.0.0.1 (default port 3514, remembered)
  slipway down [--purge]             stop it (--purge deletes all review data)
  slipway status                     runtime, port, running or not

Setup:
  slipway setup [--user slipway] [--password slipway] [--email e] [--org repos] [--admin-user admin]
                                     your login (a plain reviewer), the technical admin and the org (idempotent)
  slipway repo add <path> [--name n] [--github owner/repo] [--base main]
                                     register a local clone: Gitea repo, protection, remote "review"
  slipway sync-main <repo>           push origin/<base> to Gitea <base> (force)

Promotion (usually done by your agent):
  slipway promote <repo> <pr> [--draft] [--base b] [--test-cmd "npm test"] [--force]
                                     publish an approved PR's exact commits to GitHub (token: SLIPWAY_GITHUB_TOKEN or \`gh auth token\`)

Environment: SLIPWAY_PORT, SLIPWAY_RUNTIME (native|docker), SLIPWAY_HOME (default ~/.slipway).
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const log = (m: string) => console.error(`slipway: ${m}`);
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return 0;
    case '-v':
    case '--version':
    case 'version':
      console.log(VERSION);
      return 0;
    case 'init': {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { agent: { type: 'string' }, port: { type: 'string' }, docker: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } },
      });
      const terminal = process.stdin.isTTY && !values.yes ? terminalAsk() : undefined;
      try {
        let here: string | undefined;
        const r = await init(values, {
          ask: terminal?.ask,
          log,
          up,
          setup: (l) => bootstrap({ log: l }),
          addRepo: (path, l) => addRepo({ path, log: l }),
          repoHere: async (c) => (here = await repoHere(c)),
          ghLoggedIn,
        });
        console.error(initSummary(r, here));
      } finally {
        terminal?.close();
      }
      return 0;
    }
    case 'up': {
      const { values } = parseArgs({ args: argv.slice(1), options: { port: { type: 'string' }, docker: { type: 'boolean' } } });
      const i = await up({ port: values.port, runtime: values.docker ? 'docker' : undefined, log });
      log(`Slipway is up at http://127.0.0.1:${i.port} (${i.runtime})`);
      return 0;
    }
    case 'down': {
      const { values } = parseArgs({ args: argv.slice(1), options: { purge: { type: 'boolean' } } });
      await down({ purge: values.purge });
      return 0;
    }
    case 'status': {
      const s = await status();
      if (!s.instance) {
        console.log('not set up here yet: run slipway init');
        return 1;
      }
      let configured = '';
      try {
        const c = loadConfig();
        configured = `, login ${c.reviewer.username}, ${Object.keys(c.repos).length} repo(s)`;
      } catch {
        configured = ', not set up: run slipway setup';
      }
      console.log(`${s.running ? 'running' : 'stopped'} at ${s.url} (${s.instance.runtime}${configured})`);
      return s.running ? 0 : 3;
    }
    case 'setup': {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          user: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' }, 'gitea-url': { type: 'string' },
          'admin-user': { type: 'string' }, org: { type: 'string' },
        },
      });
      const c = await bootstrap({
        ownerUser: values.user, ownerEmail: values.email, ownerPassword: values.password, giteaUrl: values['gitea-url'],
        adminUser: values['admin-user'], org: values.org, log,
      });
      log(`ready: ${c.giteaUrl} (login: ${c.reviewer.username} / ${c.reviewer.password}; repos live in "${c.org}")`);
      return 0;
    }
    case 'repo': {
      if (sub !== 'add') throw new Error('usage: slipway repo add <path> ...');
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { name: { type: 'string' }, github: { type: 'string' }, base: { type: 'string' } },
      });
      const r = await addRepo({ path: positionals[0] ?? '.', name: values.name, github: values.github, base: values.base, log });
      log(`repo ${r.name} ready → ${r.url}`);
      return 0;
    }
    case 'sync-main': {
      if (!sub) throw new Error('usage: slipway sync-main <repo>');
      await syncMain(sub);
      log(`synced ${sub}`);
      return 0;
    }
    case 'promote': {
      const { runPromoteCli } = await import('./promote/cli.ts');
      return runPromoteCli(argv.slice(1), log);
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

/** True when this module is the program (tsx src/cli.ts, the bundle, or a symlink to either), not an import. */
function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`slipway: error: ${err.message}`);
      process.exit(1);
    },
  );
}
