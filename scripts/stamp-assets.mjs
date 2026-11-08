// Stamps the Slipway UI assets referenced from the Gitea templates with a content hash (?v=…), because Gitea serves
// custom assets with Cache-Control max-age=6h and browsers would keep stale CSS/JS. Run after changing them.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const custom = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'gitea');
const assets = ['css/slipway.css', 'js/slipway-head.js', 'js/slipway.js'];
for (const tmpl of ['templates/custom/header.tmpl', 'templates/custom/footer.tmpl']) {
  const file = join(custom, tmpl);
  let s = readFileSync(file, 'utf8');
  for (const rel of assets) {
    const v = createHash('sha256').update(readFileSync(join(custom, 'public', 'assets', rel))).digest('hex').slice(0, 10);
    s = s.replace(new RegExp(`(/${rel.replace('.', '\\.')})\\?v=[0-9a-f]+`, 'g'), `$1?v=${v}`);
  }
  writeFileSync(file, s);
}
