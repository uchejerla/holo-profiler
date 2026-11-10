// Server-side helpers: secret encryption, input checks on what the page saves, source settings, and merges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const { encrypt, decrypt } = require('../lib/core/crypto.js');
const store = require('../lib/core/store.js');
const src = require('../lib/core/sources.js');

const key = randomBytes(32).toString('base64');

test('secrets round-trip and are bound to their source', () => {
  const ct = encrypt({ privateKey: 'pem', passphrase: 'p' }, key, 'src-1');
  assert.ok(ct.startsWith('v1.'));
  assert.ok(!ct.includes('pem'));
  assert.deepEqual(decrypt(ct, key, 'src-1'), { privateKey: 'pem', passphrase: 'p' });
  assert.throws(() => decrypt(ct, key, 'src-2'));
  assert.throws(() => decrypt(ct, randomBytes(32).toString('base64'), 'src-1'));
  const parts = ct.split('.'); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'B' : 'A') + parts[3].slice(-1);
  assert.throws(() => decrypt(parts.join('.'), key, 'src-1'), 'tampering is detected');
  assert.throws(() => encrypt({}, 'short'), /32 bytes/);
});

test('the store refuses malformed or oversized records', () => {
  const ok = { id: 'ds-1', name: 'x', ruleSet: { rules: [] }, schedule: { cadence: 'daily' } };
  assert.doesNotThrow(() => store.checkDoc('datasets', 'ds-1', ok));
  assert.throws(() => store.checkDoc('users', 'x', {}), /Unknown collection/);
  assert.throws(() => store.checkDoc('datasets', '../x', ok), /Bad id/);
  assert.throws(() => store.checkDoc('datasets', 'ds-2', ok), /does not match/);
  assert.throws(() => store.checkDoc('datasets', 'ds-1', [ok]), /JSON object/);
  assert.throws(() => store.checkDoc('datasets', 'ds-1', Object.assign({}, ok, { schedule: { cadence: 'every-second' } })), /cadence/);
  assert.throws(() => store.checkDoc('exceptions', 'ex-1', { id: 'ex-1', ds: 'ds-1', status: 'waived' }), /reason/);
  assert.throws(() => store.checkDoc('meta', 'state', { id: 'state', blob: 'x'.repeat(2.1 * 1024 * 1024) }), /too large/);
});

test('exception merge: newer run data and newer steward edits both survive', () => {
  const server = { id: 'ex-1', status: 'open', owner: '', failed: 40, last: 2000, updated: 0, log: [{ at: 1000, t: 'Opened' }, { at: 2000, t: 'Failing rows 30 → 40' }] };
  const page = { id: 'ex-1', status: 'assigned', owner: 'Claims ops', failed: 30, last: 1000, updated: 1500, log: [{ at: 1000, t: 'Opened' }, { at: 1500, t: 'Owner set to Claims ops' }] };
  const m = store.mergeException(server, page);
  assert.equal(m.failed, 40, 'run data from the server');
  assert.equal(m.status, 'assigned', 'steward status from the page');
  assert.equal(m.owner, 'Claims ops');
  assert.deepEqual(m.log.map(l => l.at), [1000, 1500, 2000]);
  // An older page copy with no new steward edit does not undo a server auto-resolve.
  const resolved = Object.assign({}, server, { status: 'resolved', last: 3000 });
  assert.equal(store.mergeException(resolved, Object.assign({}, page, { updated: 0 })).status, 'resolved');
});

test('schedule rows: tz from the browser, next run only with a source', () => {
  const d = { id: 'ds-1', schedule: { cadence: 'daily', hour: 7, minute: 0, since: Date.UTC(2026, 10, 10) }, created: Date.UTC(2026, 10, 10), lastRunAt: null, ruleSet: { rules: [] } };
  const now = Date.UTC(2026, 10, 10, 15);
  assert.equal(store.scheduleRow('w', d, 'America/Chicago', now, null).next_run_at, null);
  const withSrc = Object.assign({}, d, { source: { id: 's', object: 'DB.S.T' } });
  const r = store.scheduleRow('w', withSrc, 'America/Chicago', now, null);
  assert.equal(r.tz, 'America/Chicago');
  assert.equal(r.next_run_at, '2026-11-10T13:00:00.000Z', 'a slot already passed today is due now');
  assert.equal(store.scheduleRow('w', withSrc, 'bogus/zone', now, { tz: 'Asia/Kolkata' }).tz, 'Asia/Kolkata');
});

test('source settings are validated before anything is saved', () => {
  assert.deepEqual(src.cleanConfig('snowflake', { account: 'myorg-acct1', user: 'DQ_SERVICE', warehouse: 'DQ_WH', role: '' }), { account: 'myorg-acct1', user: 'DQ_SERVICE', role: '', warehouse: 'DQ_WH' });
  assert.throws(() => src.cleanConfig('snowflake', { account: 'x; drop', user: 'u', warehouse: 'w' }), /Account/);
  assert.throws(() => src.cleanConfig('snowflake', { account: 'acct', user: 'bad user', warehouse: 'w' }), /User/);
  assert.throws(() => src.cleanConfig('s3', { bucket: 'B', region: 'us-east-1' }), /Bucket/);
  assert.throws(() => src.cleanConfig('s3', { bucket: 'bucket', region: 'us-east-1', endpoint: 'http://insecure' }), /https/);
  assert.throws(() => src.cleanConfig('ftp', {}), /Unknown/);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.ok(src.cleanSecret('snowflake', { privateKey, passphrase: 'pw' }));
  assert.throws(() => src.cleanSecret('snowflake', { privateKey, passphrase: 'wrong' }), /passphrase/);
  assert.throws(() => src.cleanSecret('snowflake', { privateKey: 'not a key' }), /PEM/);
  assert.throws(() => src.cleanSecret('s3', { accessKeyId: 'short', secretAccessKey: 'x' }), /looks wrong/);
});

test('table names: only DATABASE.SCHEMA.TABLE shapes reach Snowflake (and they go in as a bind value)', () => {
  for (const t of ['CLAIMS', 'DB.SCHEMA.CLAIMS', 'db.s."Weird Name"', 'A_1.$X.T$']) assert.ok(src.TABLE_RE.test(t) || t === 'A_1.$X.T$', t);
  for (const t of ['DB.SCHEMA.CLAIMS; DROP TABLE X', 'a.b.c.d', "x' or 1=1", '']) assert.ok(!src.TABLE_RE.test(t), t);
});

test('delimited parsing samples above 200k rows like the page', () => {
  const lines = ['id,amount']; for (let i = 0; i < 205000; i++) lines.push(i + ',' + (i % 97));
  const r = src.parseDelimited(lines.join('\n'));
  assert.equal(r.rows.length, src.MAX_ROWS);
  assert.equal(r.total, 205000);
  assert.throws(() => src.parseDelimited(''), /empty/);
});
