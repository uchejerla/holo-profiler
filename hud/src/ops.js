/* DQ operations engine: monitored datasets, schedules, run history, drift, alerts and exceptions. Pure functions, no DOM. */
(function (root) {
'use strict';
const DQR = root.DQR || (typeof require !== 'undefined' ? require('./rules.js') : null);

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const CADENCES = {
  load: { label: 'Every load', words: 'every time the file is loaded' },
  hourly: { label: 'Hourly', ms: HOUR },
  daily: { label: 'Daily', ms: DAY },
  weekly: { label: 'Weekly', ms: 7 * DAY },
  off: { label: 'Paused', words: 'paused' }
};
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'waived'];
const STATUS_LABEL = { open: 'Open', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', waived: 'Waived' };
const ACTIVE = new Set(['open', 'assigned', 'in_progress']);
const SEVS = ['critical', 'high', 'medium', 'low'];
const AGE_BUCKETS = [{ k: 'd1', label: 'Under 1 day', max: DAY }, { k: 'd7', label: '1 to 7 days', max: 7 * DAY }, { k: 'd30', label: '7 to 30 days', max: 30 * DAY }, { k: 'old', label: 'Over 30 days', max: Infinity }];
const KEEP_RUNS = 90, KEEP_LOG = 40, SAMPLE_KEYS = 12;
const DEFAULTS = { fileDrop: 3, rulesDrop: 3, ruleDrop: 5 };

/* ---------- ids, names, signatures ---------- */
function hash(s) { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function fnv(s) { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
function hash2(s) { return hash(s) + fnv(s); }
function headerSig(headers) { return hash((headers || []).join('\u0001')) + '.' + (headers || []).length; }
function uid(prefix, now) { return prefix + '-' + Math.floor(now || Date.now()).toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
// File-name stem that survives dated drops: claims_2026-11-10.csv, claims_20261110_0700.csv and claims.csv all give "claims".
function stemOf(name) {
  let s = String(name || '').toLowerCase().trim();
  s = s.replace(/\.(csv|tsv|txt|xlsx|xlsm|xls|parquet|gz|zip)$/g, '').replace(/\.(csv|tsv|txt)$/g, '');
  s = s.replace(/(19|20)\d{2}[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])([t_\-. ]?\d{2}[-_.:]?\d{2}([-_.:]?\d{2})?)?/g, ' ');
  s = s.replace(/\b(0?[1-9]|1[0-2])[-_.](0?[1-9]|[12]\d|3[01])[-_.](19|20)\d{2}\b/g, ' ');
  s = s.replace(/[-_. ]+(v|rev|run|part)?\d{1,4}$/g, ' ');
  s = s.replace(/\((\d+)\)/g, ' ').replace(/[-_. ]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'file';
}
function schemaOf(p) { return (p && p.cols ? p.cols : []).map(c => ({ n: c.name, t: c.type })); }
function keyColumn(p) {
  if (!p || !p.cols) return null;
  const k = (p.keyCandidates || [])[0];
  if (k !== undefined && k !== null) { const c = typeof k === 'number' ? p.cols[k] : typeof k === 'string' ? p.cols.find(c => c.name === k) : p.cols[k.idx] || p.cols.find(c => c.name === k.name); if (c) return c.name; }
  const id = p.cols.find(c => c.type === 'identifier' || c.type === 'uuid');
  return id ? id.name : null;
}
const clip = (v, n) => { v = v === null || v === undefined ? '' : String(v); return v.length > n ? v.slice(0, n - 1) + '…' : v; };

/* ---------- datasets and rule sets ---------- */
function cleanRule(r) { const o = JSON.parse(JSON.stringify(r)); return o; }
function ruleSetFrom(rules, name, prev) {
  const active = (rules || []).filter(r => r.status !== 'rejected').map(cleanRule);
  return { name: name || (prev && prev.name) || 'Default rules', version: prev ? (prev.version || 1) + 1 : 1, rules: active, saved: Date.now() };
}
function sameRules(a, b) {
  const pick = rs => JSON.stringify((rs || []).filter(r => r.status !== 'rejected').map(r => [r.id, r.type, r.columns, r.params, r.severity, r.when || null, r.name]).sort((x, y) => x[0] < y[0] ? -1 : 1));
  return pick(a) === pick(b);
}
function newDataset(o) {
  const now = o.now || Date.now();
  return {
    id: 'ds-' + hash2((o.stem || stemOf(o.file)) + '|' + now),
    name: clip(o.name || o.file || 'Dataset', 80), file: clip(o.file || '', 160), stem: o.stem || stemOf(o.file), sig: o.sig || headerSig(o.headers),
    keyCol: o.keyCol || null, created: now, sample: !!o.sample,
    ruleSet: ruleSetFrom(o.rules, o.ruleSetName),
    ruleNames: Object.fromEntries((o.rules || []).filter(r => r.status !== 'rejected').map(r => [r.id, clip(r.name, 120)])),
    schedule: Object.assign({ cadence: 'daily', hour: 7, minute: 0, dow: 1, since: now }, o.schedule || {}),
    thresholds: Object.assign({}, DEFAULTS, o.thresholds || {}),
    schema: o.schema || null, lastRunAt: null, lastRunId: null, lastFile: null, runCount: 0
  };
}
function matchDataset(datasets, file, headers) {
  const stem = stemOf(file), sig = headerSig(headers);
  const score = d => (d.stem === stem ? 2 : 0) + (d.sig === sig ? 1 : 0);
  let best = null;
  for (const d of datasets) { const s = score(d); if (!s) continue; if (!best || s > best.s || (s === best.s && (d.lastRunAt || 0) > (best.d.lastRunAt || 0))) best = { d, s }; }
  return best ? { dataset: best.d, byName: best.s >= 2, bySchema: best.s % 2 === 1 } : null;
}

/* ---------- schedules ---------- */
function slotAfter(sch, t) {
  const d = new Date(t), H = sch.hour | 0, M = sch.minute | 0;
  if (sch.cadence === 'hourly') { d.setMinutes(M, 0, 0); while (d.getTime() <= t) d.setHours(d.getHours() + 1); return d.getTime(); }
  if (sch.cadence === 'daily') { d.setHours(H, M, 0, 0); while (d.getTime() <= t) d.setDate(d.getDate() + 1); return d.getTime(); }
  if (sch.cadence === 'weekly') { d.setHours(H, M, 0, 0); d.setDate(d.getDate() + (((sch.dow | 0) - d.getDay() + 7) % 7)); while (d.getTime() <= t) d.setDate(d.getDate() + 7); return d.getTime(); }
  return null;
}
// Where a schedule stands now: next slot, whether a slot has passed since the last run, and how many earlier slots were missed.
function scheduleState(ds, now) {
  const sch = ds.schedule || {};
  if (sch.cadence === 'off') return { cadence: 'off', due: false, missed: 0, next: null, dueSince: null };
  if (sch.cadence === 'load') return { cadence: 'load', due: true, missed: 0, next: null, dueSince: null, onLoad: true };
  const anchor = Math.max(ds.lastRunAt || 0, sch.since || ds.created || 0);
  const first = slotAfter(sch, anchor);
  if (first === null) return { cadence: sch.cadence, due: false, missed: 0, next: null, dueSince: null };
  if (first > now) return { cadence: sch.cadence, due: false, missed: 0, next: first, dueSince: null };
  let n = 0, s = first, last = first;
  while (s <= now && n < 2000) { last = s; n++; s = slotAfter(sch, s); }
  return { cadence: sch.cadence, due: true, missed: Math.max(0, n - 1), next: s, dueSince: last, firstMissed: first };
}
function describeSchedule(sch) {
  const p2 = n => String(n).padStart(2, '0');
  const hm = h => { const H = h.hour | 0, M = h.minute | 0, ap = H < 12 ? 'AM' : 'PM', h12 = H % 12 || 12; return `${h12}:${p2(M)} ${ap}`; };
  if (!sch) return '';
  if (sch.cadence === 'hourly') return `Hourly at :${p2(sch.minute | 0)}`;
  if (sch.cadence === 'daily') return `Daily at ${hm(sch)}`;
  if (sch.cadence === 'weekly') return `${DOW[sch.dow | 0]}s at ${hm(sch)}`;
  if (sch.cadence === 'load') return 'Every time the file is loaded';
  return 'Paused';
}

/* ---------- runs ---------- */
function activeRules(ds) { return (ds.ruleSet && ds.ruleSet.rules || []).filter(r => r.status !== 'rejected'); }
// Run the dataset's saved rule set on loaded rows. Returns the run record and the raw results for exceptions.
function buildRun(o) {
  const { ds, p, rows, headers, now } = o;
  const rules = activeRules(ds);
  const results = DQR.runRules(rules, { headers, rows, now }, o.cache || new Map());
  const rs = DQR.scoreRules(rules, results, rows.length);
  const per = {};
  for (const r of rules) {
    const x = results[r.id];
    if (!x || x.error) { per[r.id] = [null, 0, 0, SEVS.indexOf(r.severity), 1]; continue; }
    per[r.id] = [x.passRate === null ? null : +x.passRate.toFixed(5), x.failed, x.checked, SEVS.indexOf(r.severity)];
  }
  const schema = schemaOf(p);
  const prev = o.prevRun || null;
  const drift = diffSchema(ds.schema || (prev && prev.schema) || null, schema);
  const run = {
    id: uid('run', now), ds: ds.id, at: now, kind: o.kind || 'manual', file: clip(o.file || '', 160), rows: p.nRows, cols: p.nCols, sampled: !!p.sampled,
    fileScore: p.score === null || p.score === undefined ? null : +p.score.toFixed(5),
    rulesScore: rs.score === null || rs.score === undefined ? null : +rs.score.toFixed(5),
    rowsPassAll: rs.rowsPassAll === null || rs.rowsPassAll === undefined ? null : +rs.rowsPassAll.toFixed(5),
    failingCritical: rs.failingCritical || 0, activeRules: rs.activeRules || 0, passingRules: rs.passingRules || 0,
    rsv: ds.ruleSet ? ds.ruleSet.version : 1, per, schema, drift, missed: o.missed || 0, sample: !!o.sample, alerts: []
  };
  run.alerts = alertsFor(ds, run, prev);
  return { run, results, rules };
}
function diffSchema(prev, cur) {
  if (!prev || !cur) return { added: [], removed: [], typed: [], first: !prev };
  const pm = new Map(prev.map(c => [c.n, c.t])), cm = new Map(cur.map(c => [c.n, c.t]));
  const added = cur.filter(c => !pm.has(c.n)).map(c => c.n);
  const removed = prev.filter(c => !cm.has(c.n)).map(c => c.n);
  const typed = cur.filter(c => pm.has(c.n) && pm.get(c.n) !== c.t).map(c => ({ c: c.n, from: pm.get(c.n), to: c.t }));
  return { added, removed, typed };
}
function hasDrift(d) { return !!(d && (d.added.length || d.removed.length || d.typed.length)); }
function alertsFor(ds, run, prev) {
  const th = Object.assign({}, DEFAULTS, ds.thresholds || {}), out = [];
  if (prev) {
    const fd = prev.fileScore !== null && run.fileScore !== null ? (prev.fileScore - run.fileScore) * 100 : 0;
    const rd = prev.rulesScore !== null && run.rulesScore !== null ? (prev.rulesScore - run.rulesScore) * 100 : 0;
    if (fd >= th.fileDrop) out.push({ k: 'file_drop', d: +fd.toFixed(2), from: prev.fileScore, to: run.fileScore });
    if (rd >= th.rulesDrop) out.push({ k: 'rules_drop', d: +rd.toFixed(2), from: prev.rulesScore, to: run.rulesScore });
    for (const id of Object.keys(run.per)) {
      const a = prev.per && prev.per[id], b = run.per[id];
      if (!a || a[0] === null || b[0] === null) continue;
      const dd = (a[0] - b[0]) * 100;
      if (dd >= th.ruleDrop) out.push({ k: 'rule_drop', rule: id, d: +dd.toFixed(2), from: a[0], to: b[0] });
    }
  }
  if (hasDrift(run.drift)) out.push({ k: 'drift', n: run.drift.added.length + run.drift.removed.length + run.drift.typed.length });
  return out;
}
function pruneRuns(runs, dsId) {
  const mine = runs.filter(r => r.ds === dsId).sort((a, b) => b.at - a.at);
  return mine.slice(KEEP_RUNS).map(r => r.id);
}

/* ---------- exceptions ---------- */
function exId(key) { return 'ex-' + hash2(key); }
function logPush(ex, at, t) { ex.log = (ex.log || []).concat([{ at, t: clip(t, 300) }]).slice(-KEEP_LOG); }
function samplesFor(x, rule, rows, headers, keyCol) {
  const kIdx = keyCol ? headers.indexOf(keyCol) : -1;
  const cols = (rule.columns || []).slice(0, 3), idx = cols.map(c => headers.indexOf(c));
  return (x.failRows || []).slice(0, SAMPLE_KEYS).map(r => ({
    row: r + 1,
    k: kIdx >= 0 && rows[r] && rows[r][kIdx] !== undefined && String(rows[r][kIdx]).trim() !== '' ? clip(rows[r][kIdx], 48) : 'row ' + (r + 1),
    v: cols.map((c, i) => [c, clip(rows[r] && idx[i] >= 0 ? rows[r][idx[i]] : '', 40)])
  }));
}
// Fold one run into the exception register. Same failure across runs updates one exception; a resolved one reopens when it fails again.
function applyRun(exMap, ds, built, ctx) {
  const { run, results, rules } = built, now = run.at, changed = new Map(), stats = { created: 0, reopened: 0, updated: 0, autoResolved: 0 };
  const touch = ex => { changed.set(ex.id, ex); exMap[ex.id] = ex; };
  const upsert = (key, init, onExisting) => {
    const id = exId(key); let ex = exMap[id];
    if (!ex) { ex = Object.assign({ id, key, ds: ds.id, status: 'open', owner: '', notes: [], log: [], first: now, last: now, runs: 1, reopened: 0, sample: !!run.sample }, init()); logPush(ex, now, ex.kind === 'rule' ? `Opened: ${ex.failed} failing rows` : 'Opened'); stats.created++; touch(ex); return ex; }
    ex = Object.assign({}, ex); ex.last = now; ex.runs = (ex.runs || 0) + 1; ex.lastRun = run.id;
    if (ex.status === 'resolved') { ex.status = ex.owner ? 'assigned' : 'open'; ex.reopened = (ex.reopened || 0) + 1; ex.resolvedAt = null; logPush(ex, now, 'Reopened: failing again after it was resolved'); stats.reopened++; }
    else if (ex.status === 'waived' && ex.waiveUntil && now > ex.waiveUntil) { ex.status = ex.owner ? 'assigned' : 'open'; logPush(ex, now, 'Waiver expired, back in the queue'); stats.reopened++; }
    else stats.updated++;
    onExisting(ex); touch(ex); return ex;
  };
  const byId = new Map(rules.map(r => [r.id, r]));
  for (const r of rules) {
    const x = results[r.id];
    if (!x || x.error || !x.checked) continue;
    const key = ds.id + '|rule|' + r.id;
    if (x.failed > 0) {
      upsert(key, () => ({ kind: 'rule', ruleId: r.id, title: clip(r.name, 160), what: clip(DQR.describe(r), 200), sev: r.severity, failed: x.failed, checked: x.checked, rate: +(x.failed / x.checked).toFixed(5), prevFailed: null, samples: samplesFor(x, r, ctx.rows, ctx.headers, ds.keyCol), keyCol: ds.keyCol || null, lastRun: run.id }),
        ex => {
          if (ex.failed !== x.failed) logPush(ex, now, `Failing rows ${ex.failed} → ${x.failed}`);
          ex.prevFailed = ex.failed; ex.failed = x.failed; ex.checked = x.checked; ex.rate = +(x.failed / x.checked).toFixed(5);
          ex.sev = r.severity; ex.title = clip(r.name, 160); ex.what = clip(DQR.describe(r), 200);
          ex.samples = samplesFor(x, r, ctx.rows, ctx.headers, ds.keyCol); ex.keyCol = ds.keyCol || null;
          if (ex.status === 'waived') ex.growing = ex.waivedFailed ? x.failed > ex.waivedFailed * 1.25 : false;
        });
    } else {
      const ex0 = exMap[exId(key)];
      if (ex0 && ACTIVE.has(ex0.status)) {
        const ex = Object.assign({}, ex0, { status: 'resolved', resolvedAt: now, resolvedBy: 'auto', prevFailed: ex0.failed, failed: 0, checked: x.checked, rate: 0, last: now, lastRun: run.id, samples: [] });
        logPush(ex, now, 'Rule passed on this run, closed automatically'); stats.autoResolved++; touch(ex);
      }
    }
  }
  const d = run.drift;
  if (hasDrift(d)) {
    const mk = (kind, col, sev, title, detail) => upsert(ds.id + '|drift|' + kind + '|' + col, () => ({ kind: 'drift', sev, title, what: detail, col }), ex => { ex.what = detail; });
    for (const c of d.removed) mk('removed', c, 'high', `Column ${clip(c, 60)} disappeared`, `${c} was in the last run and is missing now. Rules on it can no longer run.`);
    for (const c of d.added) mk('added', c, 'low', `New column ${clip(c, 60)}`, `${c} appeared since the last run. It has no rules yet.`);
    for (const t of d.typed) mk('typed', t.c, 'medium', `${clip(t.c, 60)} changed type`, `${t.c} looked like ${t.from} and now looks like ${t.to}.`);
  }
  const th = Object.assign({}, DEFAULTS, ds.thresholds || {});
  for (const a of run.alerts) {
    if (a.k !== 'file_drop' && a.k !== 'rules_drop') continue;
    const which = a.k === 'file_drop' ? 'File score' : 'Rules score';
    upsert(ds.id + '|drop|' + a.k, () => ({ kind: 'alert', alert: a.k, sev: 'high', title: `${which} fell ${a.d.toFixed(1)} points`, what: `${(a.from * 100).toFixed(1)} → ${(a.to * 100).toFixed(1)}, threshold ${th[a.k === 'file_drop' ? 'fileDrop' : 'rulesDrop']} points`, baseline: a.from, now: a.to }),
      ex => { ex.title = `${which} fell ${a.d.toFixed(1)} points`; ex.what = `${(a.from * 100).toFixed(1)} → ${(a.to * 100).toFixed(1)}`; if (!ex.baseline || ex.status === 'open') ex.baseline = Math.max(ex.baseline || 0, a.from); ex.now = a.to; });
  }
  // Score alerts close themselves once the score is back near where it was.
  for (const k of ['file_drop', 'rules_drop']) {
    const id = exId(ds.id + '|drop|' + k), ex0 = exMap[id];
    if (!ex0 || !ACTIVE.has(ex0.status) || run.alerts.some(a => a.k === k)) continue;
    const v = k === 'file_drop' ? run.fileScore : run.rulesScore, lim = (k === 'file_drop' ? th.fileDrop : th.rulesDrop) / 200;
    if (v !== null && ex0.baseline && v >= ex0.baseline - lim) { const ex = Object.assign({}, ex0, { status: 'resolved', resolvedAt: now, resolvedBy: 'auto', last: now, now: v }); logPush(ex, now, `Recovered to ${(v * 100).toFixed(1)}, closed automatically`); stats.autoResolved++; touch(ex); }
  }
  return { changed: [...changed.values()], stats, byId };
}
// A steward action on one exception. Returns a new object or throws with a message for the page.
function act(ex0, a, now, who) {
  const ex = Object.assign({}, ex0, { notes: (ex0.notes || []).slice() });
  const by = who ? ` by ${clip(who, 40)}` : '';
  if (a.owner !== undefined) {
    const o = clip(String(a.owner).trim(), 80);
    if (o !== (ex.owner || '')) { ex.owner = o; logPush(ex, now, o ? `Owner set to ${o}${by}` : `Owner cleared${by}`); }
    if (o && ex.status === 'open' && !a.status) { ex.status = 'assigned'; logPush(ex, now, 'Status Open → Assigned'); }
  }
  if (a.status === 'waived' && ex.status === 'waived') {
    const r = clip(String(a.reason || '').trim(), 400);
    if (!r) throw new Error('A waiver needs a reason.');
    if (r !== ex.waiveReason || (a.until || null) !== (ex.waiveUntil || null)) { ex.waiveReason = r; ex.waiveUntil = a.until || null; logPush(ex, now, `Waiver updated${by}: ${clip(r, 200)}`); }
  } else if (a.status && a.status !== ex.status) {
    if (!STATUSES.includes(a.status)) throw new Error('Unknown status');
    if (a.status === 'waived' && !String(a.reason || '').trim()) throw new Error('A waiver needs a reason.');
    if (a.status === 'assigned' && !ex.owner) throw new Error('Add an owner before assigning.');
    logPush(ex, now, `Status ${STATUS_LABEL[ex.status]} → ${STATUS_LABEL[a.status]}${by}${a.status === 'waived' ? ': ' + clip(a.reason, 200) : ''}`);
    ex.status = a.status;
    if (a.status === 'waived') { ex.waiveReason = clip(String(a.reason).trim(), 400); ex.waiveUntil = a.until || null; ex.waivedAt = now; ex.waivedFailed = ex.failed || 0; ex.growing = false; }
    if (a.status === 'resolved') { ex.resolvedAt = now; ex.resolvedBy = 'steward'; } else if (ex0.status === 'resolved') ex.resolvedAt = null;
  }
  if (a.note && String(a.note).trim()) { ex.notes.push({ at: now, t: clip(String(a.note).trim(), 1000), by: who ? clip(who, 40) : '' }); ex.notes = ex.notes.slice(-50); logPush(ex, now, 'Note added' + by); }
  ex.updated = now;
  return ex;
}
function ageOf(ex, now) { return Math.max(0, (ex.status === 'resolved' && ex.resolvedAt ? ex.resolvedAt : now) - (ex.first || now)); }
function ageBucket(ms) { return AGE_BUCKETS.find(b => ms < b.max).k; }
function fmtAge(ms) { if (ms < HOUR) return Math.max(1, Math.round(ms / MIN)) + 'm'; if (ms < DAY) return Math.round(ms / HOUR) + 'h'; return Math.round(ms / DAY) + 'd'; }

/* ---------- exports ---------- */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // keep spreadsheet apps from running cell text as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exceptionsCSV(list, dsById, now) {
  const iso = t => t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '';
  const head = ['exception_id', 'dataset', 'kind', 'rule_id', 'title', 'severity', 'status', 'owner', 'first_seen_utc', 'last_seen_utc', 'age_days', 'runs_seen', 'failing_rows', 'rows_checked', 'fail_rate_pct', 'times_reopened', 'waive_reason', 'waive_until_utc', 'sample_keys', 'latest_note'];
  const lines = [head.join(',')];
  for (const e of list) {
    const ds = dsById[e.ds];
    lines.push([e.id, ds ? ds.name : e.ds, e.kind, e.ruleId || '', e.title, e.sev, STATUS_LABEL[e.status] || e.status, e.owner || '', iso(e.first), iso(e.last), (ageOf(e, now) / DAY).toFixed(1), e.runs || 0,
      e.kind === 'rule' ? e.failed : '', e.kind === 'rule' ? e.checked : '', e.kind === 'rule' && e.checked ? (e.rate * 100).toFixed(2) : '', e.reopened || 0, e.waiveReason || '', iso(e.waiveUntil),
      (e.samples || []).map(s => s.k).join(' | '), e.notes && e.notes.length ? e.notes[e.notes.length - 1].t : ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
function cronFor(sch, tz) {
  const M = sch.minute | 0, H = sch.hour | 0, z = tz || 'UTC';
  if (sch.cadence === 'hourly') return `USING CRON ${M} * * * * ${z}`;
  if (sch.cadence === 'weekly') return `USING CRON ${M} ${H} * * ${sch.dow | 0} ${z}`;
  return `USING CRON ${M} ${H} * * * ${z}`;
}
const sqlStr = s => "'" + String(s === null || s === undefined ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
const sqlIdent = s => String(s || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || 'X';
// A Snowflake TASK that runs the dataset's rule set on a schedule and appends one row per rule to a results table.
function snowflakeTaskSQL(ds, o) {
  o = o || {};
  const T = DQR.sqlTable(o.table), wh = sqlIdent(o.warehouse || 'DQ_WH');
  const tq = String(o.table || '').split('.').map(s => s.trim()).filter(Boolean);
  const where = tq.length >= 3 ? tq.slice(0, 2).map(sqlIdent).join('.') + '.' : tq.length === 2 ? sqlIdent(tq[0]) + '.' : '';
  const res = where + sqlIdent(o.results || 'DQ_RULE_RESULTS'), task = where + sqlIdent(o.task || ('DQ_' + (ds.stem || 'DATASET') + '_TASK'));
  const rules = activeRules(ds).filter(r => !DQR.checkRule(r, (ds.schema || []).map(c => c.n)).length);
  const sch = ds.schedule && ds.schedule.cadence !== 'off' && ds.schedule.cadence !== 'load' ? ds.schedule : { cadence: 'daily', hour: 7, minute: 0 };
  const L = [];
  L.push(`-- Holo Profiler schedule for "${String(ds.name).replace(/[\r\n]/g, ' ')}" as a Snowflake TASK`);
  L.push(`-- Rule set: ${String(ds.ruleSet.name).replace(/[\r\n]/g, ' ')} v${ds.ruleSet.version}, ${rules.length} rules. ${describeSchedule(sch)} (${o.tz || 'UTC'}). Generated ${new Date().toISOString().slice(0, 10)}.`);
  L.push('-- The page only runs while it is open. This task runs the same checks inside Snowflake on the schedule, with no page open.');
  L.push('-- Point it at the table the file lands in, set the warehouse, then run the statements in order. Needs CREATE TASK and EXECUTE TASK.');
  L.push('');
  L.push(`CREATE TABLE IF NOT EXISTS ${res} (\n  run_at TIMESTAMP_LTZ, dataset VARCHAR, rule_set_version NUMBER, rule_id VARCHAR, rule_name VARCHAR,\n  severity VARCHAR, rows_checked NUMBER, rows_failed NUMBER\n);`);
  L.push('');
  if (!rules.length) { L.push('-- No active rules in this rule set, so there is no task to create.'); return L.join('\n') + '\n'; }
  const parts = rules.map(r => {
    const s = DQR.sqlParts(r);
    const failed = s.uniqueCols ? `COUNT(*) - COUNT(DISTINCT ${s.uniqueCols.join(', ')})` : `COUNT_IF(${s.fail})`;
    return `    SELECT ${sqlStr(r.id)} AS rule_id, ${sqlStr(r.name)} AS rule_name, ${sqlStr(String(r.severity).toUpperCase())} AS severity,\n           COUNT(*) AS rows_checked, ${failed} AS rows_failed\n    FROM ${T}\n    WHERE ${s.scope}`;
  });
  L.push(`CREATE OR REPLACE TASK ${task}\n  WAREHOUSE = ${wh}\n  SCHEDULE = '${cronFor(sch, o.tz)}'\nAS\nINSERT INTO ${res}\nSELECT CURRENT_TIMESTAMP(), ${sqlStr(ds.name)}, ${ds.ruleSet.version | 0}, rule_id, rule_name, severity, rows_checked, rows_failed\nFROM (\n${parts.join('\n    UNION ALL\n')}\n);`);
  L.push('');
  L.push(`ALTER TASK ${task} RESUME;`);
  L.push('');
  L.push(`-- Trend per rule, newest first:\n-- SELECT run_at, rule_id, rule_name, rows_failed, 1 - rows_failed / NULLIF(rows_checked, 0) AS pass_rate\n-- FROM ${res} WHERE dataset = ${sqlStr(ds.name)} ORDER BY run_at DESC, rule_id;`);
  return L.join('\n') + '\n';
}

/* ---------- sample history (clearly labelled, for first open) ---------- */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
// Builds ~3 weeks of daily runs that lead up to the current file, with a slow slide, one bad day and a schema change.
function sampleHistory(ds, current, o) {
  const now = o.now, R = rng(o.seed || 20261110), days = o.days || 21;
  const sch = ds.schedule, runs = [];
  const base = current.run;
  const ids = Object.keys(base.per);
  const lift = ids.map(() => R());                          // which rules got worse over time
  const spike = ids[Math.floor(R() * ids.length)] || null;  // one rule that blew up on the bad day
  const addedCol = (o.addedCol && base.schema.find(c => c.n === o.addedCol)) ? o.addedCol : (base.schema[base.schema.length - 1] || {}).n;
  let t = slotAfter(Object.assign({}, sch, { cadence: 'daily' }), now - (days + 1) * DAY);
  const slots = [];
  while (t < now - DAY / 2 && slots.length < days) { slots.push(t); t += DAY; }
  let prev = null;
  slots.forEach((at, i) => {
    const age = slots.length - i;                            // days before today
    const bad = age === 9, f = Math.max(0, age - 1) / days; // 0 today → ~1 three weeks ago
    const per = {};
    ids.forEach((id, k) => {
      const [pr, failed, checked, sev, err] = base.per[id];
      if (pr === null || err) { per[id] = base.per[id].slice(); return; }
      let nf = failed * (1 - 0.55 * f * lift[k]) * (0.9 + R() * 0.2);
      if (bad && id === spike) nf = failed * 3 + checked * 0.04;
      if (age > 6 && o.addedRuleCols && o.addedRuleCols.has(id)) { per[id] = [null, 0, 0, sev, 1]; return; }
      nf = Math.max(0, Math.min(checked, Math.round(nf)));
      per[id] = [+(1 - nf / Math.max(1, checked)).toFixed(5), nf, checked, sev];
    });
    const jitter = (R() - 0.5) * 0.008;
    const fileScore = Math.min(1, Math.max(0, base.fileScore + 0.045 * f + jitter - (bad ? 0.055 : 0)));
    const rulesScore = Math.min(1, Math.max(0, base.rulesScore + 0.05 * f + jitter * 1.2 - (bad ? 0.07 : 0)));
    const schema = age > 6 && addedCol ? base.schema.filter(c => c.n !== addedCol) : base.schema;
    const drift = prev ? diffSchema(prev.schema, schema) : { added: [], removed: [], typed: [], first: true };
    const run = { id: 'run-sample-' + i + '-' + hash(ds.id), ds: ds.id, at, kind: 'sample', file: base.file, rows: base.rows + Math.round((R() - 0.6) * 40) - age * 3, cols: schema.length, sampled: false,
      fileScore: +fileScore.toFixed(5), rulesScore: +rulesScore.toFixed(5), rowsPassAll: base.rowsPassAll === null ? null : +Math.min(1, base.rowsPassAll + 0.06 * f - (bad ? 0.05 : 0)).toFixed(5),
      failingCritical: base.failingCritical, activeRules: base.activeRules, passingRules: base.passingRules, rsv: 1, per, schema, drift, missed: 0, sample: true, alerts: [] };
    run.alerts = alertsFor(ds, run, prev);
    runs.push(run); prev = run;
  });
  return { runs, addedCol, spike };
}

const api = { CADENCES, DOW, STATUSES, STATUS_LABEL, ACTIVE, SEVS, AGE_BUCKETS, DEFAULTS, KEEP_RUNS, MIN, HOUR, DAY,
  hash, hash2, headerSig, uid, stemOf, schemaOf, keyColumn, clip, ruleSetFrom, sameRules, newDataset, matchDataset,
  slotAfter, scheduleState, describeSchedule, activeRules, buildRun, diffSchema, hasDrift, alertsFor, pruneRuns,
  exId, applyRun, act, ageOf, ageBucket, fmtAge, csvCell, exceptionsCSV, cronFor, snowflakeTaskSQL, sampleHistory, rng };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DQOPS = api;
})(typeof window !== 'undefined' ? window : globalThis);
