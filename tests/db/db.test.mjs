// Database tests: migrations, row-level security between workspaces, the data layer (lib/core/store.js) and a full
// server run (lib/core/runner.js) on a real Postgres. Needs a Postgres superuser URL in TEST_DATABASE_URL, e.g.
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
// It creates and drops its own throwaway database. Skipped when TEST_DATABASE_URL is not set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgClient } from './pg-client.mjs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DQ = require('../../hud/src/engine.js');
const DQR = require('../../hud/src/rules.js');
const OPS = require('../../hud/src/ops.js');
const { createStore } = require('../../lib/core/store.js');
const { runDataset, runDue } = require('../../lib/core/runner.js');
const { parseDelimited } = require('../../lib/core/sources.js');
const { encrypt, decrypt } = require('../../lib/core/crypto.js');

const URL0 = process.env.TEST_DATABASE_URL;
const skip = !URL0 && 'set TEST_DATABASE_URL to run database tests';
const dbName = 'holo_test_' + Date.now().toString(36);
let pool, A, B, wsA, wsB, sbA, sbB, admin;

const sample = parseDelimited(readFileSync(join(root, 'data/sample_claims.csv'), 'utf8'));

test.before(async () => {
  if (skip) return;
  const boot = new pg.Client({ connectionString: URL0 });
  await boot.connect();
  await boot.query(`create database ${dbName}`);
  await boot.end();
  const u = new URL(URL0); u.pathname = '/' + dbName;
  pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  await pool.query(readFileSync(join(root, 'tests/db/supabase-stub.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await pool.query(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
  A = (await pool.query(`insert into auth.users (email) values ('ana@example.com') returning id`)).rows[0].id;
  B = (await pool.query(`insert into auth.users (email) values ('ben@example.com') returning id`)).rows[0].id;
  wsA = (await pool.query('select workspace_id from public.workspace_members where user_id = $1', [A])).rows[0].workspace_id;
  wsB = (await pool.query('select workspace_id from public.workspace_members where user_id = $1', [B])).rows[0].workspace_id;
  sbA = pgClient(pool, { role: 'authenticated', uid: A });
  sbB = pgClient(pool, { role: 'authenticated', uid: B });
  admin = pgClient(pool, { role: 'service_role' });
});
test.after(async () => {
  if (skip) return;
  await pool.end();
  const boot = new pg.Client({ connectionString: URL0 });
  await boot.connect(); await boot.query(`drop database if exists ${dbName} with (force)`); await boot.end();
});

function baseline(now) {
  const p = DQ.profileTable({ headers: sample.headers, rows: sample.rows, now });
  const rules = DQR.suggestRules(p, { rows: sample.rows, headers: p.headers });
  const ds = OPS.newDataset({ name: 'Claims', file: 'claims_2026-11-10.csv', headers: p.headers, rules, keyCol: OPS.keyColumn(p), ruleSetName: 'Claims rules', schedule: { cadence: 'daily', hour: 7, minute: 0, since: now }, now });
  const built = OPS.buildRun({ ds, p, rows: sample.rows, headers: p.headers, now, kind: 'baseline', file: 'claims_2026-11-10.csv' });
  const ex = {}; const res = OPS.applyRun(ex, ds, built, { rows: sample.rows, headers: p.headers });
  const d = Object.assign({}, ds, { schema: built.run.schema, lastRunAt: now, lastRunId: built.run.id, lastFile: 'claims_2026-11-10.csv', runCount: 1 });
  return { d, run: built.run, exceptions: res.changed, rules };
}

test('a new user gets a personal workspace they own', { skip }, async () => {
  const r = await sbA.from('workspace_members').select('workspace_id, role').eq('user_id', A);
  assert.equal(r.error, null);
  assert.deepEqual(r.data, [{ workspace_id: wsA, role: 'owner' }]);
  assert.notEqual(wsA, wsB);
});

test('the page saves and reloads datasets, runs and exceptions through the data layer', { skip }, async () => {
  const store = createStore(sbA), now = Date.UTC(2026, 10, 10, 15);
  const b = baseline(now);
  await store.write(wsA, 'datasets', b.d.id, b.d, { tz: 'America/Chicago', actor: A });
  await store.write(wsA, 'runs', b.run.id, b.run, {});
  for (const e of b.exceptions) await store.write(wsA, 'exceptions', e.id, e, {});
  await store.write(wsA, 'meta', 'state', { id: 'state', sampleSeeded: true }, {});
  const all = await store.loadAll(wsA);
  assert.equal(all.datasets.length, 1);
  assert.deepEqual(all.datasets[0], b.d, 'dataset round-trips unchanged');
  assert.deepEqual(all.runs[0], b.run, 'run round-trips unchanged');
  assert.equal(all.exceptions.length, b.exceptions.length);
  assert.ok(b.exceptions.length > 0, 'the sample has failing rules');
  const rr = await pool.query('select count(*)::int n from public.rule_results where workspace_id = $1 and run_id = $2', [wsA, b.run.id]);
  assert.equal(rr.rows[0].n, Object.keys(b.run.per).length, 'one rule_results row per rule');
  const rs = await pool.query('select version, rule_count from public.rule_sets where workspace_id = $1', [wsA]);
  assert.deepEqual(rs.rows, [{ version: 1, rule_count: b.d.ruleSet.rules.length }]);
  const sch = await pool.query('select cadence, tz, next_run_at, source_id from public.schedules where workspace_id = $1', [wsA]);
  assert.equal(sch.rows[0].tz, 'America/Chicago');
  assert.equal(sch.rows[0].next_run_at, null, 'no source: the server never runs it');
});

test('row-level security keeps workspaces apart', { skip }, async () => {
  const fromB = await createStore(sbB).loadAll(wsA);
  assert.deepEqual(fromB, { datasets: [], runs: [], exceptions: [], meta: [] }, 'B sees nothing of A');
  const d = (await createStore(sbA).loadAll(wsA)).datasets[0];
  await assert.rejects(createStore(sbB).write(wsA, 'datasets', 'ds-intruder', Object.assign({}, d, { id: 'ds-intruder' }), {}), /row-level security/);
  const upd = await sbB.from('datasets').update({ name: 'hacked' }).eq('workspace_id', wsA).eq('id', d.id).select('id');
  assert.deepEqual(upd.data, [], 'B cannot update A rows');
  const del = await sbB.from('runs').delete().eq('workspace_id', wsA).select('id');
  assert.deepEqual(del.data, [], 'B cannot delete A rows');
  const anon = pgClient(pool, { role: 'anon' });
  const r = await anon.from('datasets').select('id');
  assert.ok(r.error, 'anonymous visitors have no access');
});

test('viewers can read but not write', { skip }, async () => {
  const V = (await pool.query(`insert into auth.users (email) values ('vic@example.com') returning id`)).rows[0].id;
  await pool.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')`, [wsA, V]);
  const sbV = pgClient(pool, { role: 'authenticated', uid: V });
  const got = await createStore(sbV).loadAll(wsA);
  assert.equal(got.datasets.length, 1);
  const ex = got.exceptions[0];
  await assert.rejects(createStore(sbV).write(wsA, 'exceptions', ex.id, Object.assign({}, ex, { owner: 'me' }), {}), /row-level security/);
});

test('source secrets are unreadable to members; only the server can decrypt them', { skip }, async () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const s = await sbA.from('sources').insert({ workspace_id: wsA, kind: 's3', name: 'Landing', config: { bucket: 'landing', region: 'us-east-1' } }).select('id').single();
  assert.equal(s.error, null);
  const ct = encrypt({ accessKeyId: 'AKIAEXAMPLE0000', secretAccessKey: 'x'.repeat(40) }, key, s.data.id);
  const ins = await sbA.from('source_secrets').insert({ source_id: s.data.id, workspace_id: wsA, ciphertext: ct });
  assert.ok(ins.error, 'members cannot write secrets directly');
  assert.equal((await admin.from('source_secrets').insert({ source_id: s.data.id, workspace_id: wsA, ciphertext: ct })).error, null);
  const read = await sbA.from('source_secrets').select('*');
  assert.deepEqual(read.data, [], 'members cannot read secrets');
  const back = await admin.from('source_secrets').select('ciphertext').eq('source_id', s.data.id).single();
  assert.equal(decrypt(back.data.ciphertext, key, s.data.id).accessKeyId, 'AKIAEXAMPLE0000');
  assert.throws(() => decrypt(back.data.ciphertext, key, 'another-source'), 'ciphertext is bound to its source');
  assert.ok((await sbB.from('sources').insert({ workspace_id: wsA, kind: 's3', name: 'x', config: {} })).error, 'B cannot add sources to A');
});

test('a waived exception must have a reason (database check)', { skip }, async () => {
  const ex = (await createStore(sbA).loadAll(wsA)).exceptions[0];
  const r = await sbA.from('exceptions').update({ status: 'waived', waive_reason: null }).eq('workspace_id', wsA).eq('id', ex.id).select('id');
  assert.ok(r.error && /check/.test(r.error.message));
  await assert.rejects(createStore(sbA).write(wsA, 'exceptions', ex.id, Object.assign({}, ex, { status: 'waived', waiveReason: '' }), {}), /waiver needs a reason/);
});

test('exception changes and rule set versions land in the audit log', { skip }, async () => {
  const store = createStore(sbA);
  const all = await store.loadAll(wsA);
  const ex = all.exceptions.find(e => e.kind === 'rule');
  const acted = OPS.act(ex, { owner: 'Claims ops' }, Date.now(), 'ana');
  await store.write(wsA, 'exceptions', ex.id, acted, {});
  const d = all.datasets[0];
  const d2 = Object.assign({}, d, { ruleSet: Object.assign({}, d.ruleSet, { version: 2, rules: d.ruleSet.rules.slice(1) }) });
  await store.write(wsA, 'datasets', d.id, d2, { actor: A });
  const log = (await pool.query('select action, actor, detail from public.audit_log where workspace_id = $1 order by id', [wsA])).rows;
  const owner = log.find(l => l.action === 'exception.owner');
  assert.ok(owner && owner.actor === A && owner.detail.to === 'Claims ops');
  assert.ok(log.find(l => l.action === 'rule_set.saved' && l.detail.version === 2));
  assert.ok(log.find(l => l.action === 'exception.status' && l.detail.to === 'assigned'));
  assert.equal((await pool.query('select count(*)::int n from public.rule_sets where workspace_id = $1', [wsA])).rows[0].n, 2, 'both versions kept');
  assert.deepEqual((await sbB.from('audit_log').select('id')).data, [], 'B cannot read A audit log');
});

test('a stale page cannot undo a newer server run or steward change', { skip }, async () => {
  const store = createStore(sbA);
  const all = await store.loadAll(wsA);
  const d = all.datasets[0];
  const newer = Object.assign({}, d, { lastRunAt: d.lastRunAt + 3600e3, lastRunId: 'run-server-x', runCount: d.runCount + 1 });
  await store.write(wsA, 'datasets', d.id, newer, {});
  await store.write(wsA, 'datasets', d.id, Object.assign({}, d, { name: 'Claims (renamed)' }), {});   // page still holds the old copy
  const back = (await store.loadAll(wsA)).datasets[0];
  assert.equal(back.name, 'Claims (renamed)');
  assert.equal(back.lastRunId, 'run-server-x', 'server run kept');
  assert.equal(back.runCount, d.runCount + 1);
});

test('the scheduler claims a due dataset once, runs it on the server and records everything', { skip }, async () => {
  const storeA = createStore(sbA);
  const d = (await storeA.loadAll(wsA)).datasets[0];
  const src = (await sbA.from('sources').select('id').eq('workspace_id', wsA).single()).data;
  // Attach the source and backdate the schedule so a slot is due.
  const since = Date.now() - 3 * 86400e3;
  // The store never lets a page move lastRunAt backwards, so backdate the saved copy directly for this test.
  await pool.query(`update public.datasets set doc = jsonb_set(doc, '{lastRunAt}', to_jsonb($3::bigint)) where workspace_id = $1 and id = $2`, [wsA, d.id, since]);
  await storeA.write(wsA, 'datasets', d.id, Object.assign({}, d, { lastRunAt: since, source: { id: src.id, object: 'claims/' }, schedule: Object.assign({}, d.schedule, { since }) }), { tz: 'America/Chicago' });
  const sch = (await pool.query('select next_run_at from public.schedules where workspace_id = $1 and dataset_id = $2', [wsA, d.id])).rows[0];
  assert.ok(sch.next_run_at && sch.next_run_at.getTime() <= Date.now(), 'due now');

  const fetched = [];
  const deps = {
    loadSource: async (ws, id) => ({ source: { id, kind: 's3', config: {} }, secret: {} }),
    fetchRows: async (source, secret, object) => { fetched.push(object); return { headers: sample.headers, rows: sample.rows.slice(0, 3000), total: 3000, file: 'claims_2026-11-11.csv' }; },
    storeFor: () => createStore(admin),
    claimDue: async (now, limit, lock) => { const r = await admin.rpc('claim_due_schedules', { p_now: now, p_limit: limit, p_lock_until: lock }); if (r.error) throw new Error(r.error.message); return r.data; },
    release: async () => {},
  };
  const out = await runDue(deps, {});
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].ok, true, JSON.stringify(out));
  assert.deepEqual(fetched, ['claims/']);
  assert.deepEqual(await runDue(deps, {}), [], 'nothing left due; no double run');

  const all = await storeA.loadAll(wsA);
  const run = all.runs.find(r => r.id === out[0].run);
  assert.equal(run.kind, 'scheduled');
  assert.equal(run.server, true);
  assert.ok(run.missed >= 1, 'missed slots caught up as one run');
  const row = (await pool.query('select trigger, last_status, lock_until, next_run_at from public.runs r join public.schedules s on s.workspace_id = r.workspace_id and s.dataset_id = r.dataset_id where r.id = $1', [run.id])).rows[0];
  assert.equal(row.trigger, 'server');
  assert.equal(row.last_status, 'ok');
  assert.equal(row.lock_until, null);
  assert.ok(row.next_run_at.getTime() > Date.now(), 'next slot is in the future');
  const ds = all.datasets.find(x => x.id === d.id);
  assert.equal(ds.lastRunId, run.id);
  // Exceptions were updated by the same dedupe keys: no duplicates per key.
  const keys = all.exceptions.map(e => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a failing source is recorded on the schedule and retried at the next slot, not every tick', { skip }, async () => {
  await pool.query(`update public.schedules set next_run_at = now() - interval '1 minute' where workspace_id = $1`, [wsA]);
  const deps = {
    loadSource: async (ws, id) => ({ source: { id, kind: 'snowflake', config: {} }, secret: {} }),
    fetchRows: async () => { throw new Error('Snowflake sign-in failed: JWT token is invalid'); },
    storeFor: () => createStore(admin),
    claimDue: async (now, limit, lock) => (await admin.rpc('claim_due_schedules', { p_now: now, p_limit: limit, p_lock_until: lock })).data,
    release: async () => {},
  };
  const out = await runDue(deps, {});
  assert.equal(out[0].ok, false);
  const s = (await pool.query('select last_status, last_error, next_run_at, lock_until from public.schedules where workspace_id = $1', [wsA])).rows[0];
  assert.equal(s.last_status, 'error');
  assert.match(s.last_error, /JWT token is invalid/);
  assert.equal(s.lock_until, null);
  assert.ok(s.next_run_at.getTime() > Date.now());
});

test('members cannot call the scheduler claim function', { skip }, async () => {
  const r = await sbA.rpc('claim_due_schedules', { p_now: new Date().toISOString(), p_limit: 5, p_lock_until: new Date().toISOString() });
  assert.ok(r.error && /permission denied/.test(r.error.message));
});

test('deleting a dataset removes its runs, rule results, schedule and exceptions', { skip }, async () => {
  const store = createStore(sbA);
  const d = (await store.loadAll(wsA)).datasets[0];
  await store.write(wsA, 'datasets', d.id, null, {});
  for (const t of ['runs', 'rule_results', 'schedules', 'exceptions', 'rule_sets']) {
    assert.equal((await pool.query(`select count(*)::int n from public.${t} where workspace_id = $1`, [wsA])).rows[0].n, 0, t);
  }
});
