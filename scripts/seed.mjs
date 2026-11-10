// Seeds a local workspace with two monitored datasets built from data/sample_claims.csv and data/wide_claims_250.csv,
// each with its suggested rule set and a baseline run, exactly as the page's "Start monitoring" would record them.
// Usage (after `supabase start`):  SEED_EMAIL=you@example.com npm run seed
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local. Refuses to run against a non-local URL
// unless SEED_ALLOW_REMOTE=1.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const f of ['.env.local', '.env']) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).'); process.exit(1); }
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url) && process.env.SEED_ALLOW_REMOTE !== '1') { console.error('Refusing to seed a non-local database. Set SEED_ALLOW_REMOTE=1 to override.'); process.exit(1); }

const { createClient } = require('@supabase/supabase-js');
const DQ = require('../hud/src/engine.js');
const DQR = require('../hud/src/rules.js');
const OPS = require('../hud/src/ops.js');
const { createStore } = require('../lib/core/store.js');
const { parseDelimited } = require('../lib/core/sources.js');

const email = process.env.SEED_EMAIL || 'demo@holo.local';
const tz = process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const admin = createClient(url, key, { auth: { persistSession: false } });

async function userId() {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find(x => x.email === email);
    if (u) return u.id;
    if (data.users.length < 200) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

const uid = await userId();
const { data: mem, error } = await admin.from('workspace_members').select('workspace_id').eq('user_id', uid).order('created_at').limit(1).single();
if (error) throw error;
const ws = mem.workspace_id;
const store = createStore(admin);

for (const [file, name, setName] of [['sample_claims.csv', 'P&C claims', 'Claims core rules'], ['wide_claims_250.csv', 'Wide claims (250 columns)', 'Wide claims rules']]) {
  const t0 = Date.now();
  const { headers, rows, total } = parseDelimited(readFileSync(join(root, 'data', file), 'utf8'));
  const now = Date.now();
  const p = DQ.profileTable({ headers, rows, now, sampled: total > rows.length, totalRows: total });
  const rules = DQR.suggestRules(p, { rows, headers: p.headers });
  const existing = (await store.loadAll(ws)).datasets.find(d => d.stem === OPS.stemOf(file) && !d.sample);
  if (existing) { console.log(`skip ${file}: already monitored as ${existing.name}`); continue; }
  const ds = OPS.newDataset({ name, file, headers: p.headers, rules, keyCol: OPS.keyColumn(p), ruleSetName: setName, schedule: { cadence: 'daily', hour: 7, minute: 0 }, now });
  const built = OPS.buildRun({ ds, p, rows, headers: p.headers, now, kind: 'baseline', file });
  const ex = {};
  const res = OPS.applyRun(ex, ds, built, { rows, headers: p.headers });
  const d = Object.assign({}, ds, { schema: built.run.schema, lastRunAt: now, lastRunId: built.run.id, lastFile: file, runCount: 1 });
  await store.write(ws, 'datasets', d.id, d, { tz, actor: uid });
  await store.write(ws, 'runs', built.run.id, built.run, { tz });
  for (const e of res.changed) await store.write(ws, 'exceptions', e.id, e, { tz });
  console.log(`seeded ${name}: ${rows.length} rows, ${p.nCols} columns, ${rules.length} rules, file score ${(built.run.fileScore * 100).toFixed(1)}, rules score ${built.run.rulesScore === null ? '-' : (built.run.rulesScore * 100).toFixed(1)}, ${res.changed.length} exceptions (${Date.now() - t0} ms)`);
}
console.log(`\nWorkspace ${ws} for ${email}. Sign in at http://localhost:3000/login with that address; the link arrives in the local mail viewer (http://127.0.0.1:54324).`);
