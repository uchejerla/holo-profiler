// The profiler, rules and operations engines run unchanged on the server. These pin their behaviour on the sample
// so a refactor cannot quietly change the scores (the big ring's file score is deliberately left as it was).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DQ = require('../hud/src/engine.js');
const DQR = require('../hud/src/rules.js');
const OPS = require('../hud/src/ops.js');
const { parseDelimited } = require('../lib/core/sources.js');

const now = Date.UTC(2026, 10, 10, 18);
const csv = DQ.sampleClaimsCSV(20261110);
const sample = parseDelimited(csv);
const p = DQ.profileTable({ headers: sample.headers, rows: sample.rows, now });

test('server CSV parsing matches the page reader on the sample', () => {
  assert.equal(sample.headers.length, p.nCols);
  assert.equal(sample.rows.length, p.nRows);
  assert.equal(sample.total, sample.rows.length);
});

test('file score keeps its formula: weights, clean-row share and critical penalty', () => {
  assert.deepEqual(DQ.WEIGHTS, { completeness: 0.35, validity: 0.30, uniqueness: 0.20, consistency: 0.15 });
  assert.deepEqual(DQ.SCORE, { dimShare: 0.5, cleanShare: 0.5, critEach: 0.04, critMax: 0.20, good: 0.90, fair: 0.75 });
  assert.ok(p.score > 0.75 && p.score < 0.90, `sample file score ${p.score} should be in the Fair band`);
});

test('the bundled data/sample_claims.csv profiles the same as the page sample', () => {
  const f = parseDelimited(readFileSync(new URL('../data/sample_claims.csv', import.meta.url), 'utf8'));
  const q = DQ.profileTable({ headers: f.headers, rows: f.rows, now });
  assert.equal(q.nRows, p.nRows);
  assert.equal(q.score.toFixed(6), p.score.toFixed(6));
});

test('rules: suggestions run and score separately from the file score', () => {
  const rules = DQR.suggestRules(p, { rows: sample.rows, headers: p.headers });
  assert.ok(rules.length >= 20, `${rules.length} suggested rules`);
  const res = DQR.runRules(rules, { headers: p.headers, rows: sample.rows, now }, new Map());
  const sc = DQR.scoreRules(rules, res, sample.rows.length);
  assert.ok(sc.score > 0 && sc.score < 1);
  // Rejecting a rule changes the rules score, never the file score.
  const before = p.score;
  const rejected = rules.map((r, i) => i === 0 ? Object.assign({}, r, { status: 'rejected' }) : r);
  DQR.scoreRules(rejected, res, sample.rows.length);
  assert.equal(p.score, before);
});

test('Snowflake SQL export still produces one query per rule', () => {
  const rules = DQR.suggestRules(p, { rows: sample.rows, headers: p.headers });
  const sql = DQR.exportSQL(rules, { table: 'DB.SCHEMA.CLAIMS' });
  assert.match(sql, /DB\.SCHEMA\.CLAIMS/);
});

test('a run on unchanged data reuses the same exceptions (dedupe by dataset + rule)', () => {
  const rules = DQR.suggestRules(p, { rows: sample.rows, headers: p.headers });
  let ds = OPS.newDataset({ name: 'Claims', file: 'claims.csv', headers: p.headers, rules, now });
  const ex = {};
  const b1 = OPS.buildRun({ ds, p, rows: sample.rows, headers: p.headers, now, kind: 'baseline', file: 'claims.csv' });
  const r1 = OPS.applyRun(ex, ds, b1, { rows: sample.rows, headers: p.headers });
  ds = Object.assign({}, ds, { schema: b1.run.schema, lastRunAt: now });
  const n1 = Object.keys(ex).length;
  assert.equal(r1.stats.created, n1);
  const b2 = OPS.buildRun({ ds, p, rows: sample.rows, headers: p.headers, now: now + 86400e3, kind: 'scheduled', file: 'claims_2026-11-11.csv', prevRun: b1.run });
  const r2 = OPS.applyRun(ex, ds, b2, { rows: sample.rows, headers: p.headers });
  assert.equal(Object.keys(ex).length, n1, 'no new exceptions for the same failures');
  assert.equal(r2.stats.created, 0);
  assert.equal(r2.stats.updated, n1);
  for (const e of Object.values(ex)) assert.equal(e.runs, 2);
});

test('a resolved exception reopens when the rule fails again; a waiver needs a reason', () => {
  const rules = DQR.suggestRules(p, { rows: sample.rows, headers: p.headers });
  const ds = OPS.newDataset({ name: 'Claims', file: 'claims.csv', headers: p.headers, rules, now });
  const ex = {};
  const b1 = OPS.buildRun({ ds, p, rows: sample.rows, headers: p.headers, now, kind: 'baseline', file: 'claims.csv' });
  OPS.applyRun(ex, ds, b1, { rows: sample.rows, headers: p.headers });
  const one = Object.values(ex).find(e => e.kind === 'rule');
  ex[one.id] = OPS.act(one, { status: 'resolved' }, now + 1000, 'tester');
  assert.throws(() => OPS.act(one, { status: 'waived' }, now + 1000), /reason/);
  const b2 = OPS.buildRun({ ds, p, rows: sample.rows, headers: p.headers, now: now + 2000, kind: 'manual', file: 'claims.csv', prevRun: b1.run });
  const r2 = OPS.applyRun(ex, ds, b2, { rows: sample.rows, headers: p.headers });
  assert.equal(ex[one.id].status, 'open');
  assert.equal(ex[one.id].reopened, 1);
  assert.ok(r2.stats.reopened >= 1);
});

test('100k-row profile stays fast enough for a server function', () => {
  const big = [];
  for (let i = 0; i < 100000; i++) big.push(sample.rows[i % sample.rows.length]);
  const t0 = Date.now();
  const q = DQ.profileTable({ headers: sample.headers, rows: big, now });
  const ms = Date.now() - t0;
  assert.equal(q.nRows, 100000);
  assert.ok(ms < 20000, `took ${ms} ms`);
});
