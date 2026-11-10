/* Reading rows from connected sources, server side. Returns the same { headers, rows } shape the page builds
   from a dropped file, so the profiler and rules run unchanged. Rows above MAX_ROWS are sampled, like the page. */
'use strict';
const nodeCrypto = require('node:crypto');
const Papa = require('papaparse');
const DQ = require('../../hud/src/engine.js');

const MAX_ROWS = DQ.MAX_ROWS;                      // 200,000, same cap as the page
const MAX_S3_BYTES = 250 * 1024 * 1024;
const TABLE_RE = /^("[^"]{1,255}"|[A-Za-z_][A-Za-z0-9_$]{0,254})(\.("[^"]{1,255}"|[A-Za-z_][A-Za-z0-9_$]{0,254})){0,2}$/;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/;
const IDENT_RE = /^("[^"]{1,255}"|[A-Za-z_][A-Za-z0-9_$]{0,254})$/;

class SourceError extends Error { constructor(msg, code) { super(msg); this.code = code || 'source_error'; } }

/* ---------- validation of what a member may save ---------- */
function cleanConfig(kind, c) {
  c = c || {};
  const s = v => String(v === undefined || v === null ? '' : v).trim();
  if (kind === 'snowflake') {
    const out = { account: s(c.account), user: s(c.user), role: s(c.role), warehouse: s(c.warehouse) };
    if (!ACCOUNT_RE.test(out.account)) throw new SourceError('Account identifier looks wrong (use orgname-account or the locator).', 'invalid');
    for (const k of ['user', 'warehouse']) if (!IDENT_RE.test(out[k])) throw new SourceError(`${k[0].toUpperCase() + k.slice(1)} must be a Snowflake identifier.`, 'invalid');
    if (out.role && !IDENT_RE.test(out.role)) throw new SourceError('Role must be a Snowflake identifier.', 'invalid');
    return out;
  }
  if (kind === 's3') {
    const out = { bucket: s(c.bucket), region: s(c.region), endpoint: s(c.endpoint) };
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(out.bucket)) throw new SourceError('Bucket name looks wrong.', 'invalid');
    if (!/^[a-z0-9-]{2,32}$/.test(out.region)) throw new SourceError('Region looks wrong (for example us-east-1).', 'invalid');
    if (out.endpoint && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(out.endpoint)) throw new SourceError('Endpoint must be an https address.', 'invalid');
    return out;
  }
  throw new SourceError('Unknown source kind', 'invalid');
}
function cleanSecret(kind, x) {
  x = x || {};
  if (kind === 'snowflake') {
    const pem = String(x.privateKey || '').trim(), pass = String(x.passphrase || '');
    if (!/-----BEGIN (ENCRYPTED )?PRIVATE KEY-----/.test(pem)) throw new SourceError('Paste the private key in PEM format (BEGIN PRIVATE KEY).', 'invalid');
    try { nodeCrypto.createPrivateKey({ key: pem, format: 'pem', passphrase: pass || undefined }); }
    catch (e) { throw new SourceError('The private key could not be read. Check the passphrase.', 'invalid'); }
    return { privateKey: pem, passphrase: pass };
  }
  if (kind === 's3') {
    const a = String(x.accessKeyId || '').trim(), k = String(x.secretAccessKey || '');
    if (!/^[A-Z0-9]{12,128}$/.test(a) || k.length < 16) throw new SourceError('Access key ID or secret looks wrong.', 'invalid');
    return { accessKeyId: a, secretAccessKey: k };
  }
  throw new SourceError('Unknown source kind', 'invalid');
}

/* ---------- Snowflake (key-pair auth) ---------- */
function snowflakeSdk() {
  const sf = require('snowflake-sdk');
  try { sf.configure({ logLevel: 'ERROR', additionalLogToConsole: false }); } catch (e) { /* older sdk */ }
  return sf;
}
function pkcs8(secret) {
  return nodeCrypto.createPrivateKey({ key: secret.privateKey, format: 'pem', passphrase: secret.passphrase || undefined }).export({ format: 'pem', type: 'pkcs8' }).toString();
}
async function sfConnect(config, secret) {
  const sf = snowflakeSdk();
  const conn = sf.createConnection({
    account: config.account, username: config.user, role: config.role || undefined, warehouse: config.warehouse,
    authenticator: 'SNOWFLAKE_JWT', privateKey: pkcs8(secret), application: 'HoloProfiler', timeout: 60000
  });
  await new Promise((ok, no) => conn.connect(err => err ? no(new SourceError('Snowflake sign-in failed: ' + err.message, 'auth')) : ok()));
  return conn;
}
function sfExec(conn, sqlText, binds) {
  return new Promise((ok, no) => conn.execute({
    sqlText, binds, fetchAsString: ['Number', 'Date', 'Boolean', 'JSON'],
    complete: (err, stmt, rows) => err ? no(new SourceError('Snowflake: ' + err.message, 'query')) : ok({ stmt, rows: rows || [] })
  }));
}
function sfClose(conn) { return new Promise(ok => { try { conn.destroy(() => ok()); } catch (e) { ok(); } }); }
async function sfSession(conn) {
  for (const s of ["ALTER SESSION SET TIMEZONE = 'UTC'", "ALTER SESSION SET DATE_OUTPUT_FORMAT = 'YYYY-MM-DD'",
    "ALTER SESSION SET TIMESTAMP_NTZ_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS'", "ALTER SESSION SET TIMESTAMP_LTZ_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS TZH:TZM'",
    "ALTER SESSION SET TIMESTAMP_TZ_OUTPUT_FORMAT = 'YYYY-MM-DD HH24:MI:SS TZH:TZM'", "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 600",
    "ALTER SESSION SET QUERY_TAG = 'holo-profiler'"]) await sfExec(conn, s);
}
async function snowflakeRows(config, secret, table) {
  if (!TABLE_RE.test(table || '')) throw new SourceError('Table must look like DATABASE.SCHEMA.TABLE.', 'invalid');
  const conn = await sfConnect(config, secret);
  try {
    await sfSession(conn);
    const cnt = await sfExec(conn, 'SELECT COUNT(*) AS N FROM IDENTIFIER(?)', [table]);
    const total = parseInt((cnt.rows[0] || {}).N, 10) || 0;
    const q = total > MAX_ROWS ? `SELECT * FROM IDENTIFIER(?) SAMPLE ROW (${MAX_ROWS} ROWS)` : 'SELECT * FROM IDENTIFIER(?)';
    const { stmt, rows } = await sfExec(conn, q, [table]);
    const headers = stmt.getColumns().map(c => c.getName());
    const out = rows.map(r => headers.map(h => r[h] === null || r[h] === undefined ? '' : String(r[h])));
    return { headers, rows: out, total: Math.max(total, out.length), file: table };
  } finally { await sfClose(conn); }
}
async function snowflakeTest(config, secret) {
  const conn = await sfConnect(config, secret);
  try {
    const r = await sfExec(conn, 'SELECT CURRENT_USER() AS U, CURRENT_ROLE() AS R, CURRENT_WAREHOUSE() AS W');
    const x = r.rows[0] || {};
    return `Connected as ${x.U} with role ${x.R}${x.W ? ', warehouse ' + x.W : ' (warehouse not available to this role)'}.`;
  } finally { await sfClose(conn); }
}

/* ---------- S3 (CSV / TSV / TXT) ---------- */
function s3Client(config, secret) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({ region: config.region, endpoint: config.endpoint || undefined, forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey } });
}
async function newestUnder(cli, bucket, prefix) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  let token, best = null;
  for (let page = 0; page < 20; page++) {
    const r = await cli.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) if (/\.(csv|tsv|txt)$/i.test(o.Key) && (!best || o.LastModified > best.LastModified)) best = o;
    if (!r.IsTruncated) break; token = r.NextContinuationToken;
  }
  if (!best) throw new SourceError(`No .csv, .tsv or .txt files under ${prefix}`, 'not_found');
  return best.Key;
}
function parseDelimited(text) {
  let headers = null; const res = new DQ.Reservoir(MAX_ROWS);
  Papa.parse(text, { skipEmptyLines: true, step: r => { if (!headers) headers = r.data; else res.push(r.data); } });
  if (!headers || !headers.length) throw new SourceError('The file is empty.', 'empty');
  return { headers, rows: res.rows, total: res.seen };
}
async function s3Rows(config, secret, object) {
  const key0 = String(object || '').replace(/^\/+/, '');
  if (!key0 || key0.length > 1024) throw new SourceError('Give an S3 key, or a prefix ending in / for the newest file.', 'invalid');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cli = s3Client(config, secret);
  try {
    const key = key0.endsWith('/') ? await newestUnder(cli, config.bucket, key0) : key0;
    if (!/\.(csv|tsv|txt)$/i.test(key)) throw new SourceError('Server runs read CSV, TSV or TXT files. Excel and Parquet still work by dropping them on the page.', 'unsupported');
    const r = await cli.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    if (r.ContentLength && r.ContentLength > MAX_S3_BYTES) throw new SourceError('The file is larger than 250 MB.', 'too_large');
    const text = await r.Body.transformToString('utf-8');
    const p = parseDelimited(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return Object.assign(p, { file: key.split('/').pop() });
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError('S3: ' + (e.name === 'NoSuchKey' ? 'no such file' : e.name === 'AccessDenied' ? 'access denied' : e.message), 'query');
  } finally { cli.destroy(); }
}
async function s3Test(config, secret) {
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const cli = s3Client(config, secret);
  try { await cli.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 })); return `Connected to s3://${config.bucket}.`; }
  catch (e) { throw new SourceError('S3: ' + (e.name === 'AccessDenied' ? 'access denied (needs s3:ListBucket and s3:GetObject)' : e.message), 'auth'); }
  finally { cli.destroy(); }
}

async function fetchRows(source, secret, object) {
  if (source.kind === 'snowflake') return snowflakeRows(source.config, secret, object);
  if (source.kind === 's3') return s3Rows(source.config, secret, object);
  throw new SourceError('Unknown source kind');
}
async function testSource(source, secret) {
  if (source.kind === 'snowflake') return snowflakeTest(source.config, secret);
  if (source.kind === 's3') return s3Test(source.config, secret);
  throw new SourceError('Unknown source kind');
}

module.exports = { MAX_ROWS, TABLE_RE, SourceError, cleanConfig, cleanSecret, fetchRows, testSource, parseDelimited };
