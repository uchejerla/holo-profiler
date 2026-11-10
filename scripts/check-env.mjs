// Checks the app's settings before a deploy, printing names and problems only, never values.
// Usage: npm run check:env                 (reads .env.local, then the shell environment)
//        npm run check:env -- --production  (also requires https addresses and NEXT_PUBLIC_SITE_URL)
//        npm run check:env -- path/to/file  (reads another env file, e.g. one exported from Vercel)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkEnv } = require('../lib/core/env-check.js');

const args = process.argv.slice(2);
const production = args.includes('--production');
const file = args.find(a => !a.startsWith('--')) || '.env.local';

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
const env = Object.assign({}, process.env, fromFile);
const r = checkEnv(env, { production });
console.log(`Checked ${existsSync(file) ? file + ' and ' : ''}the shell environment${production ? ' for production' : ''}.`);
if (r.ok) { console.log('All settings look right.'); process.exit(0); }
for (const p of r.problems) console.log(`- ${p.name}: ${p.problem}${p.where ? `  (${p.where})` : ''}`);
process.exit(1);
