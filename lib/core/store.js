/* The data layer: maps the page's objects (datasets, runs, exceptions, meta) onto the Postgres tables,
   and reads them back. Works with any Supabase client: the signed-in user's (RLS applies) or the service role (scheduler). */
'use strict';
const { nextRunAt, validTz } = require('./schedule.js');

const COLLS = { datasets: 'datasets', runs: 'runs', exceptions: 'exceptions', meta: 'workspace_meta' };
const ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const iso = t => (t === null || t === undefined || t === '' || !isFinite(t)) ? null : new Date(Number(t)).toISOString();
const ms = s => s ? Date.parse(s) : null;
const num = v => (v === null || v === undefined || !isFinite(v)) ? null : Number(v);
const int = v => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(Number(v));
const SEVS = ['critical', 'high', 'medium', 'low'];
const TIMED_OR_NOT = new Set(['load', 'hourly', 'daily', 'weekly', 'off']);

class StoreError extends Error { constructor(msg, status, code) { super(msg); this.status = status || 400; this.code = code || 'invalid_argument'; } }

function checkDoc(coll, id, doc) {
  if (!Object.prototype.hasOwnProperty.call(COLLS, coll)) throw new StoreError('Unknown collection', 404, 'not_found');
  if (!ID_RE.test(String(id))) throw new StoreError('Bad id');
  if (doc === null) return;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new StoreError('Body must be a JSON object');
  if (doc.id !== id) throw new StoreError('Body id does not match the address');
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_DOC_BYTES) throw new StoreError('Record is too large', 413);
  if (coll === 'runs' && !ID_RE.test(String(doc.ds || ''))) throw new StoreError('Run has no dataset');
  if (coll === 'exceptions') {
    if (!ID_RE.test(String(doc.ds || ''))) throw new StoreError('Exception has no dataset');
    if (!['open', 'assigned', 'in_progress', 'resolved', 'waived'].includes(doc.status)) throw new StoreError('Bad exception status');
    if (doc.status === 'waived' && !String(doc.waiveReason || '').trim()) throw new StoreError('A waiver needs a reason.');
  }
  if (coll === 'datasets') {
    if (!doc.ruleSet || !Array.isArray(doc.ruleSet.rules)) throw new StoreError('Dataset has no rule set');
    if (doc.schedule && !TIMED_OR_NOT.has(doc.schedule.cadence)) throw new StoreError('Bad cadence');
  }
}

/* ---------- merges: a page holding an older copy must not undo what the scheduler recorded ---------- */
const RUN_FIELDS = ['lastRunAt', 'lastRunId', 'lastFile', 'runCount', 'schema', 'sig', 'keyCol'];
function mergeDataset(prev, next) {
  if (!prev) return next;
  const out = Object.assign({}, next);
  if ((prev.lastRunAt || 0) > (next.lastRunAt || 0)) for (const k of RUN_FIELDS) if (prev[k] !== undefined) out[k] = prev[k];
  out.runCount = Math.max(prev.runCount || 0, out.runCount || 0);
  return out;
}
const STEWARD_FIELDS = ['status', 'owner', 'notes', 'waiveReason', 'waiveUntil', 'waivedAt', 'waivedFailed', 'growing', 'resolvedAt', 'resolvedBy', 'updated'];
function mergeException(prev, next) {
  if (!prev) return next;
  const prevNewerRun = (prev.last || 0) > (next.last || 0);
  const nextNewerSteward = (next.updated || 0) > (prev.updated || 0);
  let out;
  if (prevNewerRun) {
    out = Object.assign({}, prev);
    if (nextNewerSteward) for (const k of STEWARD_FIELDS) if (next[k] !== undefined) out[k] = next[k];
  } else {
    out = Object.assign({}, next);
    if (!nextNewerSteward && (prev.updated || 0) > (next.updated || 0)) for (const k of STEWARD_FIELDS) if (prev[k] !== undefined) out[k] = prev[k];
  }
  const seen = new Set(), log = [];
  for (const e of [...(prev.log || []), ...(next.log || [])]) { const k = e.at + '|' + e.t; if (!seen.has(k)) { seen.add(k); log.push(e); } }
  out.log = log.sort((a, b) => a.at - b.at).slice(-40);   // ops.js keeps the last 40 entries
  return out;
}

/* ---------- rows ---------- */
function datasetRow(ws, d) {
  return { workspace_id: ws, id: d.id, name: String(d.name || 'Dataset').slice(0, 120), stem: d.stem || null, schema_sig: d.sig || null,
    key_col: d.keyCol || null, is_sample: !!d.sample, rule_set_version: int(d.ruleSet && d.ruleSet.version), last_run_at: iso(d.lastRunAt), doc: d };
}
function scheduleRow(ws, d, tz, now, prevRow) {
  const s = d.schedule || { cadence: 'off' };
  const src = d.source && d.source.id ? d.source : null;
  const zone = validTz(tz) ? tz : (prevRow && prevRow.tz) || (validTz(s.tz) ? s.tz : 'UTC');
  return { workspace_id: ws, dataset_id: d.id, cadence: s.cadence, hour: (s.hour | 0) % 24, minute: (s.minute | 0) % 60, dow: (s.dow | 0) % 7, tz: zone,
    since: iso(s.since), source_id: src ? src.id : null, source_object: src ? String(src.object || '').slice(0, 512) : null,
    next_run_at: iso(nextRunAt(d, now, zone, !!(src && src.object))) };
}
function ruleSetRow(ws, d, actor) {
  const rs = d.ruleSet;
  return { workspace_id: ws, dataset_id: d.id, version: int(rs.version) || 1, name: String(rs.name || 'Rules').slice(0, 160), rules: rs.rules,
    rule_count: rs.rules.length, saved_at: iso(rs.saved) || new Date().toISOString(), saved_by: actor || null };
}
function runRow(ws, r) {
  return { workspace_id: ws, id: r.id, dataset_id: r.ds, at: iso(r.at), kind: String(r.kind || 'manual'), trigger: r.server ? 'server' : 'browser', file: r.file || null,
    row_count: int(r.rows), col_count: int(r.cols), sampled: !!r.sampled, file_score: num(r.fileScore), rules_score: num(r.rulesScore), rows_pass_all: num(r.rowsPassAll),
    failing_critical: int(r.failingCritical), active_rules: int(r.activeRules), passing_rules: int(r.passingRules), rule_set_version: int(r.rsv), doc: r };
}
function ruleResultRows(ws, r) {
  return Object.entries(r.per || {}).map(([rule, v]) => ({ workspace_id: ws, run_id: r.id, rule_id: String(rule).slice(0, 200),
    pass_rate: num(v[0]), failed: int(v[1]) || 0, checked: int(v[2]) || 0, severity: SEVS[v[3]] || null, errored: !!v[4] }));
}
function exceptionRow(ws, e) {
  return { workspace_id: ws, id: e.id, dedupe_key: String(e.key || e.id), dataset_id: e.ds, kind: e.kind, rule_id: e.ruleId || null, severity: e.sev || null,
    status: e.status, owner: e.owner || null, waive_reason: e.waiveReason || null, waive_until: iso(e.waiveUntil), failed_rows: int(e.failed),
    first_seen: iso(e.first), last_seen: iso(e.last), resolved_at: iso(e.resolvedAt), doc: e };
}

/* ---------- database access ---------- */
function ok(res, what) {
  if (res.error) { const e = new StoreError((what ? what + ': ' : '') + res.error.message, 500, 'unavailable'); e.pg = res.error; throw e; }
  return res.data;
}
async function selectAll(q, page) {
  page = page || 1000; const out = [];
  for (let from = 0; ; from += page) {
    const data = ok(await q().range(from, from + page - 1));
    out.push(...data);
    if (data.length < page) return out;
  }
}

function createStore(sb, opts) {
  opts = opts || {};
  const clock = opts.now || (() => Date.now());

  async function loadAll(ws) {
    const get = (t, order) => selectAll(() => sb.from(t).select('doc').eq('workspace_id', ws).order(order || 'id'));
    const [datasets, runs, exceptions, meta] = await Promise.all([get('datasets'), get('runs', 'at'), get('exceptions'), get('workspace_meta')]);
    return { datasets: datasets.map(r => r.doc), runs: runs.map(r => r.doc), exceptions: exceptions.map(r => r.doc), meta: meta.map(r => r.doc) };
  }

  async function getDoc(table, ws, id) {
    return ok(await sb.from(table).select('doc').eq('workspace_id', ws).eq('id', id).maybeSingle());
  }

  async function write(ws, coll, id, doc, ctx) {
    ctx = ctx || {};
    checkDoc(coll, id, doc);
    const table = COLLS[coll];
    if (doc === null) { ok(await sb.from(table).delete().eq('workspace_id', ws).eq('id', id), 'delete'); return null; }
    if (coll === 'datasets') {
      const prev = await getDoc('datasets', ws, id);
      const d = mergeDataset(prev && prev.doc, doc);
      if (d.source && d.source.id) {
        const src = ok(await sb.from('sources').select('id').eq('workspace_id', ws).eq('id', d.source.id).maybeSingle());
        if (!src) throw new StoreError('That data source is not in this workspace', 400);
      }
      ok(await sb.from('datasets').upsert(datasetRow(ws, d), { onConflict: 'workspace_id,id' }), 'dataset');
      const prevSch = ok(await sb.from('schedules').select('tz').eq('workspace_id', ws).eq('dataset_id', id).maybeSingle());
      ok(await sb.from('schedules').upsert(scheduleRow(ws, d, ctx.tz, clock(), prevSch), { onConflict: 'workspace_id,dataset_id' }), 'schedule');
      ok(await sb.from('rule_sets').upsert(ruleSetRow(ws, d, ctx.actor), { onConflict: 'workspace_id,dataset_id,version', ignoreDuplicates: true }), 'rule set');
      return d;
    }
    if (coll === 'runs') {
      ok(await sb.from('runs').upsert(runRow(ws, doc), { onConflict: 'workspace_id,id' }), 'run');
      ok(await sb.from('rule_results').delete().eq('workspace_id', ws).eq('run_id', id), 'rule results');
      const rr = ruleResultRows(ws, doc);
      for (let i = 0; i < rr.length; i += 500) ok(await sb.from('rule_results').insert(rr.slice(i, i + 500)), 'rule results');
      return doc;
    }
    if (coll === 'exceptions') {
      const prev = await getDoc('exceptions', ws, id);
      const e = mergeException(prev && prev.doc, doc);
      ok(await sb.from('exceptions').upsert(exceptionRow(ws, e), { onConflict: 'workspace_id,id' }), 'exception');
      return e;
    }
    ok(await sb.from('workspace_meta').upsert({ workspace_id: ws, id, doc }, { onConflict: 'workspace_id,id' }), 'meta');
    return doc;
  }

  async function datasetDoc(ws, id) { const r = await getDoc('datasets', ws, id); return r ? r.doc : null; }
  async function schedule(ws, id) { return ok(await sb.from('schedules').select('*').eq('workspace_id', ws).eq('dataset_id', id).maybeSingle()); }
  async function runsOf(ws, dsId) { return (await selectAll(() => sb.from('runs').select('doc').eq('workspace_id', ws).eq('dataset_id', dsId).order('at'))).map(r => r.doc); }
  async function exceptionsOf(ws, dsId) {
    const list = (await selectAll(() => sb.from('exceptions').select('doc').eq('workspace_id', ws).eq('dataset_id', dsId).order('id'))).map(r => r.doc);
    return Object.fromEntries(list.map(e => [e.id, e]));
  }
  async function setScheduleStatus(ws, dsId, patch) {
    const row = {};
    for (const k of ['next_run_at', 'last_run_at', 'last_status', 'last_error', 'lock_until']) if (k in patch) row[k] = patch[k];
    ok(await sb.from('schedules').update(row).eq('workspace_id', ws).eq('dataset_id', dsId), 'schedule status');
  }
  return { loadAll, write, datasetDoc, schedule, runsOf, exceptionsOf, setScheduleStatus, client: sb };
}

module.exports = { COLLS, ID_RE, StoreError, checkDoc, mergeDataset, mergeException, datasetRow, scheduleRow, ruleSetRow, runRow, ruleResultRows, exceptionRow, createStore, iso, ms };
