/* Operations UI: view tabs, monitored datasets and schedules, run history and trends, exception queue, dashboard. */
(function () {
'use strict';
const O = DQOPS;
const $ = id => document.getElementById(id);
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-US');
const pct = v => v === null || v === undefined || isNaN(v) ? '—' : v >= 0.9995 && v < 1 ? '99.9%' : (v * 100).toFixed(1) + '%';
const sc = v => v === null || v === undefined || isNaN(v) ? '—' : (v * 100).toFixed(1);
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const KIND_LABEL = { rule: 'Rule', drift: 'Schema drift', alert: 'Score alert' };
const RUN_KIND = { manual: 'Run now', scheduled: 'Scheduled', load: 'On load', baseline: 'Baseline', sample: 'Sample history' };
const bandHex = s => s === null || s === undefined ? '#4f7690' : s >= DQ.SCORE.good ? '#3dfcb4' : s >= DQ.SCORE.fair ? '#ffbe55' : '#ff5a7a';
const SEV_HEX = { critical: '#ff5a7a', high: '#ffbe55', medium: '#b48cff', low: '#5fe1ff' };
const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
const dtf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const df = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const when = t => t ? dtf.format(new Date(t)) : '—';
function rel(t, now) {
  if (!t) return '—';
  const d = t - now, a = Math.abs(d), s = d >= 0;
  if (a < O.MIN) return 'just now';
  const v = a < O.HOUR ? Math.max(1, Math.round(a / O.MIN)) + ' min' : a < O.DAY ? Math.round(a / O.HOUR) + ' h' : Math.round(a / O.DAY) + ' d';
  return s ? 'in ' + v : v + ' ago';
}

/* ---------- state ---------- */
const S = {
  ready: false, mode: 'pending', db: null, ds: {}, runs: [], ex: {}, meta: {},
  cur: null, view: 'profile', mon: null, exf: { status: 'active', sev: 'all', ds: 'all', kind: 'all', q: '', age: 'all' }, sel: new Set(), openEx: null,
  pending: false, taskBox: null, confirmDel: null, monFlagged: false, monAll: false, lastNow: Date.now()
};
const dsList = () => Object.values(S.ds).sort((a, b) => (b.lastRunAt || b.created) - (a.lastRunAt || a.created));
const runsOf = id => S.runs.filter(r => r.ds === id).sort((a, b) => a.at - b.at);
const lastRun = id => { let b = null; for (const r of S.runs) if (r.ds === id && (!b || r.at > b.at)) b = r; return b; };
const exList = () => Object.values(S.ex);
const activeEx = () => exList().filter(e => O.ACTIVE.has(e.status) && S.ds[e.ds]);

/* ---------- storage: claude.ai db when available, this browser otherwise ---------- */
const COLLS = ['datasets', 'runs', 'exceptions', 'meta', 'rulechunks'];
const CHUNK = 120;            // rules per stored chunk, so wide rule sets stay under the per-record size limit
const chunkState = {};        // dataset id -> { v: rule set version written, n: chunk count }
const LKEY = c => 'holo.ops.v1.' + c;
const queue = new Map(); let draining = false, localTimer = 0, lastErr = '';
function local() { try { const k = '__holo_t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; } }
// Hosted app: the workspace database behind the app's own API (see server-bridge.js).
const SRV = window.HoloServer && window.HoloServer.store ? window.HoloServer : null;
function intakeAll(data) {
  S.ds = {}; S.runs = []; S.ex = {}; S.meta = {};
  for (const c of ['datasets', 'runs', 'exceptions', 'meta']) intake(c, (data && data[c]) || []);
}
async function initStore() {
  if (SRV) {
    try { intakeAll(await SRV.store.load()); S.mode = 'server'; }
    catch (e) { S.mode = 'memory'; lastErr = 'Could not reach your workspace (' + ((e && e.message) || 'network error') + '). Changes on this page will not be saved until you reload.'; }
    S.ready = true; renderStore();
    if (S.pending && S.cur) { S.pending = false; process(); } else renderAll();
    return;
  }
  let db = null;
  if (window.claude && typeof window.claude.use === 'function') {
    try { db = await Promise.race([window.claude.use('db'), new Promise(r => setTimeout(() => r(null), 11000))]); } catch (e) { db = null; }
  }
  if (db) {
    try {
      const got = await Promise.all(COLLS.map(c => db.collection('holo/v1/' + c).limit(1000).get()));
      S.db = db; S.mode = 'cloud';
      const chunks = [];
      got.forEach((snap, i) => { const docs = snap.docs.filter(d => d.exists).map(d => JSON.parse(JSON.stringify(d.data()))); if (COLLS[i] === 'rulechunks') chunks.push(...docs); else intake(COLLS[i], docs); });
      assemble(chunks);
    } catch (e) { S.db = null; }
  }
  if (!S.db) {
    if (local()) {
      S.mode = 'local';
      for (const c of COLLS) { try { const t = localStorage.getItem(LKEY(c)); if (t) intake(c, Object.values(JSON.parse(t) || {})); } catch (e) { /* ignore broken copy */ } }
    } else S.mode = 'memory';
  }
  S.ready = true; renderStore();
  if (S.pending && S.cur) { S.pending = false; process(); } else renderAll();
}
function assemble(chunks) {
  for (const d of Object.values(S.ds)) {
    const rs = d.ruleSet; if (!rs || !rs.chunks) continue;
    const mine = chunks.filter(c => c.ds === d.id && c.v === rs.version).sort((a, b) => a.k - b.k);
    if (mine.length === rs.chunks) { rs.rules = mine.flatMap(c => c.rules || []); delete rs.chunks; }
    else d.ruleSetMissing = true;
    chunkState[d.id] = { v: rs.version, n: mine.length || rs.chunks || 0 };
  }
}
function intake(c, list) {
  for (const o of list) {
    if (!o || typeof o !== 'object' || !o.id) continue;
    if (c === 'datasets') S.ds[o.id] = o; else if (c === 'runs') S.runs.push(o); else if (c === 'exceptions') S.ex[o.id] = o; else if (c === 'meta') S.meta[o.id] = o;
  }
}
function put(c, o) {
  if (c === 'datasets') S.ds[o.id] = o; else if (c === 'exceptions') S.ex[o.id] = o; else if (c === 'meta') S.meta[o.id] = o;
  else if (c === 'runs') { const i = S.runs.findIndex(r => r.id === o.id); if (i >= 0) S.runs[i] = o; else S.runs.push(o); }
  persist(c, o.id, o);
}
function del(c, id) {
  if (c === 'datasets') delete S.ds[id]; else if (c === 'exceptions') delete S.ex[id]; else if (c === 'meta') delete S.meta[id];
  else if (c === 'runs') S.runs = S.runs.filter(r => r.id !== id);
  persist(c, id, null);
}
function persist(c, id, o) {
  if (S.mode === 'cloud' && c === 'datasets') {
    const cs = chunkState[id] || { v: null, n: 0 };
    if (!o) { for (let k = 0; k < cs.n; k++) queue.set('rulechunks/' + id + '.' + k, { c: 'rulechunks', id: id + '.' + k, o: null }); delete chunkState[id]; }
    else {
      const rules = o.ruleSet.rules || [], n = Math.ceil(rules.length / CHUNK);
      if (cs.v !== o.ruleSet.version) {
        for (let k = 0; k < n; k++) queue.set('rulechunks/' + id + '.' + k, { c: 'rulechunks', id: id + '.' + k, o: { id: id + '.' + k, ds: id, v: o.ruleSet.version, k, rules: rules.slice(k * CHUNK, (k + 1) * CHUNK) } });
        for (let k = n; k < cs.n; k++) queue.set('rulechunks/' + id + '.' + k, { c: 'rulechunks', id: id + '.' + k, o: null });
        chunkState[id] = { v: o.ruleSet.version, n };
      }
      o = Object.assign({}, o, { ruleSet: Object.assign({}, o.ruleSet, { rules: [], chunks: n }) });
    }
    queue.set(c + '/' + id, { c, id, o }); drain(); return;
  }
  if (S.mode === 'cloud' || S.mode === 'server') { queue.set(c + '/' + id, { c, id, o }); drain(); }
  else if (S.mode === 'local') { clearTimeout(localTimer); localTimer = setTimeout(saveLocalAll, 250); }
}
function saveLocalAll() {
  try {
    localStorage.setItem(LKEY('datasets'), JSON.stringify(S.ds)); localStorage.setItem(LKEY('exceptions'), JSON.stringify(S.ex)); localStorage.setItem(LKEY('meta'), JSON.stringify(S.meta));
    localStorage.setItem(LKEY('runs'), JSON.stringify(Object.fromEntries(S.runs.map(r => [r.id, r]))));
    lastErr = '';
  } catch (e) { lastErr = 'This browser ran out of room for history. Delete old datasets to free space.'; }
  renderStore();
}
async function drain() {
  if (draining) return; draining = true; renderStore();
  try {
    while (queue.size) {
      const batch = [...queue.values()].slice(0, 3);
      batch.forEach(b => queue.delete(b.c + '/' + b.id));
      await Promise.all(batch.map(b => write(b)));
    }
  } finally { draining = false; renderStore(); }
}
async function write(b, retry) {
  try {
    if (S.mode === 'server') await SRV.store.write(b.c, b.id, b.o);
    else { const ref = S.db.doc('holo/v1/' + b.c + '/' + b.id); if (b.o) await ref.set(b.o); else await ref.delete(); }
    lastErr = '';
  }
  catch (e) {
    const code = e && e.code;
    if (code === 'unavailable' && !retry) { await new Promise(r => setTimeout(r, 400 + Math.random() * 900)); return write(b, true); }
    if (code === 'resource_exhausted' && !retry) { await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500)); return write(b, true); }
    lastErr = code === 'quota_exceeded' ? 'Your saved history is full. Delete a dataset or clear the sample history to make room.' : code === 'revoked' || code === 'not_granted' ? 'Saving stopped on this page. Changes stay until you close it.' : code === 'signed_out' ? 'You were signed out. Sign in again to keep saving.' : code === 'conflict' ? 'Someone else changed this item. Reload to see the latest.' : code === 'invalid_argument' ? 'One record was too large to save.' : 'A change did not save. It will stay on this page until you reload.';
  }
}
function renderStore() {
  const el = $('opsStore'); if (!el) return;
  const pendingN = queue.size + (draining ? 1 : 0);
  const txt = !S.ready ? 'Connecting storage…' : lastErr ? lastErr : S.mode === 'server' ? (pendingN ? 'Saving…' : 'Saved to your workspace') : S.mode === 'cloud' ? (pendingN ? 'Saving…' : 'History saved to your claude.ai account') : S.mode === 'local' ? 'History saved in this browser only' : 'History is not saved here: storage is off';
  el.className = 'vstore ' + ((S.mode === 'cloud' || S.mode === 'server') && !lastErr ? 'cloud' : S.mode === 'local' && !lastErr ? 'local' : '');
  el.lastElementChild.textContent = txt;
}

/* ---------- small helpers ---------- */
let toastT = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 5200); }
let downloads = null;
if (window.claude && typeof window.claude.use === 'function') window.claude.use('downloads').then(d => { downloads = d; }).catch(() => {});
async function offer(filename, data, fallbackHost) {
  if (downloads) {
    try { await downloads.save({ filename, data }); toast('Saved ' + filename + '.'); return; }
    catch (e) { if (e && e.code === 'declined') { toast('Save cancelled.'); return; } }
  }
  if (fallbackHost) { fallbackHost.hidden = false; const ta = fallbackHost.querySelector('textarea'); if (ta) { ta.value = data; ta.focus(); ta.select(); } }
  toast('Saving files is not available here. The text is shown so you can copy it.');
}
function ring(v, size, stroke, label) {
  const r = (size - stroke) / 2 - 2, c = size / 2, circ = 2 * Math.PI * r, x = v === null || v === undefined ? 0 : Math.max(0, Math.min(1, v)), col = bandHex(v);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(95,225,255,0.13)" stroke-width="${stroke}"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-dasharray="${(circ * x).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})" style="filter:drop-shadow(0 0 4px ${col})"/><text x="${c}" y="${c + size * 0.09}" text-anchor="middle" fill="#d6f4ff" font-family="JetBrains Mono, monospace" font-size="${size * 0.26}">${label}</text></svg>`;
}
function spark(vals, w, h, color, opts) {
  opts = opts || {};
  const pts = vals.map((v, i) => [i, v]).filter(p => p[1] !== null && p[1] !== undefined && !isNaN(p[1]));
  if (pts.length < 2) return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="rgba(95,225,255,0.2)" stroke-dasharray="2 3"/></svg>`;
  let lo = opts.min !== undefined ? opts.min : Math.min(...pts.map(p => p[1])), hi = opts.max !== undefined ? opts.max : Math.max(...pts.map(p => p[1]));
  if (hi - lo < 0.01) { const m = (hi + lo) / 2; lo = m - 0.005; hi = m + 0.005; }
  const n = Math.max(1, vals.length - 1), X = i => (i / n) * (w - 4) + 2, Y = v => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const d = pts.map((p, k) => (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" style="overflow:visible"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" style="filter:drop-shadow(0 0 3px ${color})"/>${opts.second ? '' : `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2.4" fill="${color}"/>`}</svg>`;
}
function delta(a, b, unit) {
  if (a === null || b === null || a === undefined || b === undefined) return '<span class="flat">—</span>';
  const d = (b - a) * 100;
  if (Math.abs(d) < 0.05) return '<span class="flat">0.0</span>';
  return `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}${unit || ''}</span>`;
}
const sevDot = s => `<span class="dot ${esc(s)}" title="${esc(SEV_LABEL[s] || s)}"></span>`;
const pill = s => `<span class="pill ${esc(s)}">${esc(O.STATUS_LABEL[s] || s)}</span>`;
function ruleName(ds, id) { const r = ds && ds.ruleSet && ds.ruleSet.rules.find(r => r.id === id); return r ? r.name : ds && ds.ruleNames && ds.ruleNames[id] || id; }
function titleCase(s) { return String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim(); }
function consoleRules() { return window.HoloRules && HoloRules.state ? HoloRules.state.rules : []; }

/* ---------- file loaded: match, catch up, record ---------- */
function fileLoaded(p, rows, src) {
  S.cur = { p, rows, src, headers: p.headers, keyCol: O.keyColumn(p), match: null };
  if (!S.ready) { S.pending = true; renderStrip(); return; }
  process();
}
function process() {
  const c = S.cur; if (!c) return;
  if (c.src && c.src.kind === 'sample' && !O.matchDataset(dsList(), c.src.name, c.headers) && !(S.meta.state && S.meta.state.sampleSeeded)) {
    try { seedSample(); } catch (e) { console.warn('sample history', e); }
  }
  c.match = O.matchDataset(dsList(), c.src.name, c.headers);
  c.note = '';
  if (c.match) {
    const ds = c.match.dataset, st = O.scheduleState(ds, Date.now());
    const serverOwned = S.mode === 'server' && ds.source && ds.source.id && !st.onLoad;
    if (st.due && !serverOwned && ds.lastRunAt !== null && !(c.src.kind === 'sample' && c.justSeeded)) {
      const kind = st.onLoad ? 'load' : 'scheduled';
      const r = recordRun(ds, kind, st.missed);
      c.note = st.onLoad ? 'Recorded a run for this load.' : st.missed ? `Ran the scheduled check and caught up ${st.missed} missed run${st.missed > 1 ? 's' : ''}.` : 'Ran the scheduled check that was due.';
      if (r && r.alerts.length) c.note += ' ' + alertWords(r.alerts, ds);
    }
  }
  c.justSeeded = false;
  renderAll();
}
function alertWords(alerts, ds) {
  const out = [];
  const f = alerts.find(a => a.k === 'file_drop'), r = alerts.find(a => a.k === 'rules_drop'), rd = alerts.filter(a => a.k === 'rule_drop'), dr = alerts.find(a => a.k === 'drift');
  if (f) out.push(`File score fell ${f.d.toFixed(1)} points.`);
  if (r) out.push(`Rules score fell ${r.d.toFixed(1)} points.`);
  if (rd.length) out.push(`${rd.length} rule${rd.length > 1 ? 's' : ''} dropped past the threshold.`);
  if (dr) out.push('The columns changed since the last run.');
  return out.join(' ');
}
function recordRun(ds, kind, missed) {
  const c = S.cur; if (!c) return null;
  const now = Date.now();
  const prev = lastRun(ds.id);
  const built = O.buildRun({ ds, p: c.p, rows: c.rows, headers: c.headers, now, kind, missed: missed || 0, file: c.src.name, prevRun: prev, sample: ds.sample && c.src.kind === 'sample' });
  const res = O.applyRun(S.ex, ds, built, { rows: c.rows, headers: c.headers });
  const d = Object.assign({}, ds, { schema: built.run.schema, sig: O.headerSig(c.headers), lastRunAt: now, lastRunId: built.run.id, lastFile: O.clip(c.src.name, 160), runCount: (ds.runCount || 0) + 1, keyCol: ds.keyCol || c.keyCol || null });
  put('datasets', d);
  put('runs', built.run);
  for (const ex of res.changed) put('exceptions', ex);
  for (const id of O.pruneRuns(S.runs, ds.id)) del('runs', id);
  if (c.match && c.match.dataset.id === ds.id) c.match.dataset = d;
  return built.run;
}

/* ---------- sample history ---------- */
function seedSample() {
  const c = S.cur, now = Date.now(), start = now - 22 * O.DAY;
  const rules = consoleRules().length ? consoleRules() : DQR.suggestRules(c.p, { rows: c.rows, headers: c.headers });
  const ds = O.newDataset({ name: 'P&C claims (sample)', file: c.src.name, headers: c.headers, rules, keyCol: c.keyCol, now: start, sample: true, ruleSetName: 'Claims core rules', schedule: { cadence: 'daily', hour: 7, minute: 0, since: start } });
  const cur = O.buildRun({ ds, p: c.p, rows: c.rows, headers: c.headers, now, kind: 'sample', file: c.src.name, sample: true });
  const addedCol = c.headers.includes('adjuster') ? 'adjuster' : c.headers[c.headers.length - 1];
  const addedRuleCols = new Set(O.activeRules(ds).filter(r => (r.columns || []).includes(addedCol)).map(r => r.id));
  const h = O.sampleHistory(ds, cur, { now, addedCol, addedRuleCols });
  const ex = {};
  let dsx = Object.assign({}, ds, { schema: null });
  for (const run of h.runs) { O.applyRun(ex, dsx, { run, results: {}, rules: [] }, { rows: c.rows, headers: c.headers }); dsx = Object.assign({}, dsx, { schema: run.schema }); }
  const lastH = h.runs[h.runs.length - 1];
  cur.run.drift = O.diffSchema(lastH.schema, cur.run.schema); cur.run.alerts = O.alertsFor(dsx, cur.run, lastH);
  O.applyRun(ex, dsx, cur, { rows: c.rows, headers: c.headers });
  // Backdate rule exceptions to the first run of their current failing streak, so ages look like a live queue.
  const all = h.runs.concat([cur.run]);
  for (const e of Object.values(ex)) {
    if (e.kind !== 'rule') continue;
    let k = all.length - 1; while (k > 0 && all[k - 1].per[e.ruleId] && all[k - 1].per[e.ruleId][1] > 0) k--;
    e.first = all[k].at; e.runs = all.length - k; if (e.log && e.log[0]) e.log[0].at = e.first;
  }
  const rulesEx = Object.values(ex).filter(e => e.kind === 'rule' && O.ACTIVE.has(e.status)).sort((a, b) => O.SEVS.indexOf(a.sev) - O.SEVS.indexOf(b.sev) || b.failed - a.failed);
  const set = (e, a, at) => { if (e) ex[e.id] = O.act(ex[e.id], a, at); };
  set(rulesEx[0], { owner: 'Claims ops', note: 'Looks like a batch was sent twice. Checking with the source team.' }, now - 3 * O.DAY);
  set(rulesEx[1], { owner: 'Data steward' }, now - 2 * O.DAY);
  if (rulesEx[1]) set(rulesEx[1], { status: 'in_progress', note: 'Fix drafted. Re-checking after tomorrow\'s load.' }, now - O.DAY);
  const low = rulesEx.slice(2).find(e => e.sev === 'low' || e.sev === 'medium');
  set(low, { status: 'waived', reason: 'Known format from an older intake system. Accepted until that system is retired.', until: now + 30 * O.DAY }, now - 5 * O.DAY);
  const drift = Object.values(ex).find(e => e.kind === 'drift');
  set(drift, { owner: 'Data steward', status: 'resolved', note: 'Expected new column from the intake change. Rules added.' }, now - 5 * O.DAY);
  for (const e of Object.values(ex)) e.sample = true;
  const finalDs = Object.assign({}, dsx, { schema: cur.run.schema, lastRunAt: cur.run.at, lastRunId: cur.run.id, lastFile: c.src.name, runCount: all.length });
  put('datasets', finalDs);
  for (const r of all) put('runs', r);
  for (const e of Object.values(ex)) put('exceptions', e);
  put('meta', { id: 'state', sampleSeeded: true, seededAt: now });
  c.justSeeded = true;
}
function clearSample(ds, rebuild) {
  for (const r of runsOf(ds.id)) del('runs', r.id);
  for (const e of exList().filter(e => e.ds === ds.id)) del('exceptions', e.id);
  del('datasets', ds.id);
  put('meta', { id: 'state', sampleSeeded: true, seededAt: Date.now(), cleared: true });
  if (rebuild && S.cur && S.cur.src.kind === 'sample') { seedSample(); S.cur.match = O.matchDataset(dsList(), S.cur.src.name, S.cur.headers); }
  renderAll();
}

/* ---------- views ---------- */
const VIEWS = ['profile', 'dash', 'monitor', 'exceptions', 'schedules'];
function show(v, focusTab) {
  if (!VIEWS.includes(v)) v = 'profile';
  S.view = v;
  for (const k of VIEWS) {
    const tab = $('tab-' + k), panel = $('v-' + k), on = k === v;
    tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1; panel.hidden = !on;
  }
  if (focusTab) $('tab-' + v).focus();
  try { localStorage.setItem('holo.ops.view', v); } catch (e) { /* ignore */ }
  renderView();
  if (v === 'profile') window.dispatchEvent(new Event('resize')); else window.scrollTo({ top: 0 });
}
$('vtabs').addEventListener('click', e => { const b = e.target.closest('[role="tab"]'); if (b) show(b.dataset.v); });
$('vtabs').addEventListener('keydown', e => {
  const i = VIEWS.indexOf(S.view); let j = -1;
  if (e.key === 'ArrowRight') j = (i + 1) % VIEWS.length; else if (e.key === 'ArrowLeft') j = (i - 1 + VIEWS.length) % VIEWS.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = VIEWS.length - 1;
  if (j >= 0) { e.preventDefault(); show(VIEWS[j], true); }
});
function renderAll() { renderStore(); renderBadges(); renderStrip(); renderView(); }
function renderView() {
  if (S.view === 'dash') renderDash(); else if (S.view === 'monitor') renderMonitor(); else if (S.view === 'exceptions') renderExceptions(); else if (S.view === 'schedules') renderSchedules();
}
function renderBadges() {
  const act = activeEx(), crit = act.filter(e => e.sev === 'critical').length;
  const eb = $('exBadge'); eb.textContent = act.length ? String(act.length) : ''; eb.className = 'tbadge' + (crit ? ' crit' : '');
  eb.title = act.length ? `${act.length} open exceptions${crit ? ', ' + crit + ' critical' : ''}` : '';
  const now = Date.now(), due = dsList().filter(d => { const s = O.scheduleState(d, now); return s.due && !s.onLoad; }).length;
  const sb = $('schBadge'); sb.textContent = due ? String(due) : ''; sb.className = 'tbadge' + (due ? ' warn' : ''); sb.title = due ? `${due} scheduled run${due > 1 ? 's' : ''} due` : '';
}

/* ---------- profile strip ---------- */
function renderStrip() {
  const el = $('opsStrip'), c = S.cur;
  if (!c) { el.hidden = true; return; }
  el.hidden = false; el.className = 'opsstrip';
  if (!S.ready) { el.innerHTML = '<span class="muted">Checking whether this file is monitored…</span>'; return; }
  const m = c.match;
  if (!m) {
    el.innerHTML = `<span class="grow"><b>Not monitored yet.</b> <span class="muted">Save this file's rules as a monitored dataset to get scheduled checks, trends and an exception queue.</span></span><button type="button" class="btn" data-a="monitor-new">Monitor this file</button>`;
    return;
  }
  const ds = m.dataset, now = Date.now(), st = O.scheduleState(ds, now), lr = lastRun(ds.id);
  const differ = !O.sameRules(consoleRules(), ds.ruleSet.rules);
  const openN = activeEx().filter(e => e.ds === ds.id).length;
  const bits = [`<b>${esc(ds.name)}</b>${ds.sample ? ' <span class="tag sample">Sample</span>' : ''}`, `<span class="muted">${esc(O.describeSchedule(ds.schedule))}</span>`];
  if (lr) bits.push(`<span class="muted">last run ${esc(rel(lr.at, now))}</span>`);
  if (!st.onLoad && st.due) { el.classList.add('due'); bits.push(`<span style="color:var(--warn)">a run is due${st.missed ? `, ${st.missed} missed` : ''}</span>`); }
  else if (st.next) bits.push(`<span class="muted">next ${esc(rel(st.next, now))}</span>`);
  if (openN) bits.push(`<a href="#" data-a="go-ex" data-ds="${esc(ds.id)}" style="color:var(--crit)">${openN} open exception${openN > 1 ? 's' : ''}</a>`);
  const lrAlerts = lr && lr.at > now - 60e3 ? lr.alerts : [];
  if (lrAlerts && lrAlerts.length) el.classList.add('alert');
  el.innerHTML = `<span class="grow">${bits.join(' · ')}${c.note ? `<br><span>${esc(c.note)}</span>` : ''}${m.byName && !m.bySchema ? '<br><span style="color:var(--warn)">Same file name, different columns from last time. Check the drift on Monitoring.</span>' : ''}${differ ? `<br><span class="muted">The rule console differs from the saved rule set (v${ds.ruleSet.version}).</span>` : ''}</span>
    ${differ ? `<button type="button" class="btn ghost" data-a="save-rules" data-ds="${esc(ds.id)}">Save console rules to set</button><button type="button" class="btn ghost" data-a="load-rules" data-ds="${esc(ds.id)}">Use saved set in console</button>` : ''}
    <button type="button" class="btn" data-a="run" data-ds="${esc(ds.id)}">Run now</button>
    <button type="button" class="btn ghost" data-a="go-mon" data-ds="${esc(ds.id)}">Trends</button>`;
}

/* ---------- actions shared by all views ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b || !b.closest('.wrap')) return;
  const a = b.dataset.a, ds = b.dataset.ds ? S.ds[b.dataset.ds] : null;
  if (b.tagName === 'A') e.preventDefault();
  if (a === 'monitor-new') { show('schedules'); setTimeout(() => { const f = $('nmName'); if (f) f.focus(); }, 30); }
  else if (a === 'go-ex') { S.exf = Object.assign({}, S.exf, { ds: b.dataset.ds || 'all', status: b.dataset.status || 'active', sev: b.dataset.sev || 'all', age: b.dataset.age || 'all', kind: 'all', q: '' }); S.sel.clear(); show('exceptions'); }
  else if (a === 'go-mon') { S.mon = b.dataset.ds; show('monitor'); }
  else if (a === 'go-sch') show('schedules');
  else if (a === 'run' && ds) runNow(ds);
  else if (a === 'save-rules' && ds) saveRules(ds);
  else if (a === 'load-rules' && ds) { if (window.HoloRules && HoloRules.replace(ds.ruleSet.rules)) { toast(`Loaded ${ds.ruleSet.name} v${ds.ruleSet.version} into the rule console.`); renderStrip(); } }
  else if (a === 'open-ex') { S.openEx = b.dataset.id; S.exf = Object.assign({}, S.exf, { status: 'all', ds: 'all', sev: 'all', kind: 'all', age: 'all', q: '' }); show('exceptions'); setTimeout(() => { const r = document.querySelector(`[data-exrow="${CSS.escape(b.dataset.id)}"]`); if (r) r.scrollIntoView({ block: 'center' }); }, 40); }
});
function loadedFor(ds) { return S.cur && S.cur.match && S.cur.match.dataset.id === ds.id; }
function runNow(ds) {
  if (!loadedFor(ds)) { toast(`Drop ${ds.lastFile || ds.name} on the page first, then run it.`); return; }
  const st = O.scheduleState(ds, Date.now());
  const r = recordRun(ds, st.due && !st.onLoad ? 'scheduled' : 'manual', st.due && !st.onLoad ? st.missed : 0);
  S.cur.note = `Run recorded: file ${sc(r.fileScore)}, rules ${sc(r.rulesScore)}.` + (r.alerts.length ? ' ' + alertWords(r.alerts, ds) : '');
  toast(S.cur.note);
  renderAll();
}
function saveRules(ds) {
  const rs = O.ruleSetFrom(consoleRules(), ds.ruleSet.name, ds.ruleSet);
  const names = Object.assign({}, ds.ruleNames || {}); for (const r of rs.rules) names[r.id] = O.clip(r.name, 120);
  put('datasets', Object.assign({}, ds, { ruleSet: rs, ruleNames: names, ruleSetMissing: false }));
  if (S.cur && S.cur.match && S.cur.match.dataset.id === ds.id) S.cur.match.dataset = S.ds[ds.id];
  toast(`Saved ${rs.rules.length} rules as ${rs.name} v${rs.version}. The next run uses them.`);
  renderAll();
}

/* ---------- dashboard ---------- */
function renderDash() {
  const el = $('v-dash'), now = Date.now(), list = dsList();
  if (!S.ready) { el.innerHTML = '<div class="panel"><div class="empty">Loading saved history…</div></div>'; return; }
  if (!list.length) { el.innerHTML = `<section class="panel"><div class="ph"><h2>Dashboard</h2></div><div class="empty">Nothing is monitored yet. Load a file, set up its rules, then choose <b>Monitor this file</b>.<br><br><button type="button" class="btn" data-a="monitor-new">Monitor a file</button></div></section>`; return; }
  const act = activeEx(), crit = act.filter(e => e.sev === 'critical').length, runs7 = S.runs.filter(r => r.at > now - 7 * O.DAY && S.ds[r.ds]).length;
  const oldest = act.reduce((m, e) => Math.max(m, O.ageOf(e, now)), 0);
  const sts = list.map(d => O.scheduleState(d, now)), due = sts.filter(s => s.due && !s.onLoad).length, missed = sts.reduce((a, s) => a + (s.onLoad ? 0 : s.missed || 0), 0);
  const waived = exList().filter(e => e.status === 'waived' && S.ds[e.ds]).length;
  const anySample = list.some(d => d.sample);
  const kpis = `<div class="kpis">
    <div class="kpi"><div class="lbl">Datasets monitored</div><div class="v">${list.length}</div><div class="s">${list.filter(d => d.schedule.cadence !== 'off').length} on a schedule</div></div>
    <div class="kpi"><div class="lbl">Runs, last 7 days</div><div class="v">${runs7}</div><div class="s">${S.runs.filter(r => S.ds[r.ds]).length} kept in history</div></div>
    <div class="kpi ${act.length ? 'warn' : 'good'}"><div class="lbl">Open exceptions</div><div class="v">${act.length}</div><div class="s">${waived} waived</div></div>
    <div class="kpi ${crit ? 'crit' : 'good'}"><div class="lbl">Critical open</div><div class="v">${crit}</div><div class="s">${act.filter(e => e.sev === 'high').length} high</div></div>
    <div class="kpi"><div class="lbl">Oldest open</div><div class="v">${act.length ? O.fmtAge(oldest) : '—'}</div><div class="s">${act.filter(e => O.ageOf(e, now) > 7 * O.DAY).length} older than a week</div></div>
    <div class="kpi ${due ? 'warn' : ''}"><div class="lbl">Runs due</div><div class="v">${due}</div><div class="s">${missed ? missed + ' missed slots' : 'none missed'}</div></div>
  </div>`;
  const cards = list.map(d => {
    const rs = runsOf(d.id), lr = rs[rs.length - 1], st = O.scheduleState(d, now), mine = act.filter(e => e.ds === d.id);
    const bySev = O.SEVS.map(s => [s, mine.filter(e => e.sev === s).length]);
    const fileS = rs.slice(-20).map(r => r.fileScore), rulesS = rs.slice(-20).map(r => r.rulesScore);
    const lo = Math.min(...fileS.concat(rulesS).filter(v => v !== null), 1) - 0.01, hi = Math.max(...fileS.concat(rulesS).filter(v => v !== null), 0) + 0.01;
    const stTxt = st.cadence === 'off' ? 'Paused' : st.onLoad ? 'Runs on every load' : st.due ? `<span style="color:var(--warn)">Due now${st.missed ? ', ' + st.missed + ' missed' : ''}</span>` : 'Next ' + esc(rel(st.next, now));
    return `<article class="dscard">
      <div class="top"><div><h3>${esc(d.name)}</h3><div class="sub">${esc(d.ruleSet.name)} v${d.ruleSet.version} · ${d.ruleSet.rules.length} rules · ${esc(O.describeSchedule(d.schedule))}</div></div>${d.sample ? '<span class="tag sample">Sample</span>' : ''}</div>
      <div class="rings">
        <div>${ring(lr ? lr.fileScore : null, 58, 5, lr ? sc(lr.fileScore).split('.')[0] : '—')}<div class="lbl">File</div></div>
        <div>${ring(lr ? lr.rulesScore : null, 58, 5, lr ? sc(lr.rulesScore).split('.')[0] : '—')}<div class="lbl">Rules</div></div>
        <div class="spk" title="File score (cyan) and rules score (violet), last ${rs.slice(-20).length} runs">
          <div style="position:relative;height:44px"><div style="position:absolute;inset:0">${spark(fileS, 160, 44, '#5fe1ff', { min: lo, max: hi })}</div><div style="position:absolute;inset:0">${spark(rulesS, 160, 44, '#b48cff', { min: lo, max: hi })}</div></div>
          <div class="sub">${lr ? 'Last run ' + esc(rel(lr.at, now)) : 'No runs yet'} · ${stTxt}</div>
        </div>
      </div>
      <div class="sevcounts">${mine.length ? bySev.map(([s, n]) => `<span>${sevDot(s)} ${SEV_LABEL[s]} <b>${n}</b></span>`).join('') : '<span style="color:var(--good)">No open exceptions</span>'}</div>
      <div class="acts"><button type="button" class="mini" data-a="go-mon" data-ds="${esc(d.id)}">Trends</button><button type="button" class="mini" data-a="go-ex" data-ds="${esc(d.id)}">Exceptions</button><button type="button" class="mini" data-a="go-sch">Schedule</button></div>
    </article>`;
  }).join('');
  // severity × age matrix of open exceptions
  const heat = `<table class="heat"><thead><tr><th></th>${O.AGE_BUCKETS.map(b => `<th>${esc(b.label)}</th>`).join('')}</tr></thead><tbody>${O.SEVS.map(s => `<tr><th>${sevDot(s)} ${SEV_LABEL[s]}</th>${O.AGE_BUCKETS.map(b => {
    const n = act.filter(e => e.sev === s && O.ageBucket(O.ageOf(e, now)) === b.k).length;
    const glow = n ? `box-shadow:inset 0 0 ${Math.min(26, 6 + n * 3)}px ${SEV_HEX[s]}55;border-color:${SEV_HEX[s]}88` : '';
    return `<td><button type="button" data-n="${n}" ${n ? `data-a="go-ex" data-sev="${s}" data-age="${b.k}"` : 'tabindex="-1" aria-disabled="true"'} style="${glow}" aria-label="${n} ${SEV_LABEL[s]} exceptions open ${esc(b.label.toLowerCase())}">${n}</button></td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
  // top failing rules across datasets, from each dataset's latest run
  const rows = [];
  for (const d of list) {
    const rs = runsOf(d.id), lr = rs[rs.length - 1]; if (!lr) continue;
    for (const [id, v] of Object.entries(lr.per)) {
      if (!v || v[0] === null || !v[1]) continue;
      const sev = O.SEVS[v[3]] || 'low', w = { critical: 4, high: 3, medium: 2, low: 1 }[sev];
      const ex = S.ex[O.exId(d.id + '|rule|' + id)];
      rows.push({ d, id, sev, rate: v[0], failed: v[1], checked: v[2], w, hist: rs.slice(-14).map(r => r.per[id] ? r.per[id][0] : null), ex });
    }
  }
  rows.sort((a, b) => b.w * (1 - b.rate) - a.w * (1 - a.rate) || b.failed - a.failed);
  const top = rows.slice(0, 8).map(r => `<tr class="click" data-a="${r.ex ? 'open-ex' : 'go-mon'}" data-id="${esc(r.ex ? r.ex.id : '')}" data-ds="${esc(r.d.id)}" tabindex="0">
      <td>${sevDot(r.sev)}</td><td style="min-width:180px">${esc(ruleName(r.d, r.id))}<div class="fine">${esc(r.d.name)}</div></td>
      <td class="num">${nf0.format(r.failed)}</td><td class="num">${pct(r.rate)}</td><td>${spark(r.hist, 90, 24, SEV_HEX[r.sev], {})}</td><td>${r.ex ? pill(r.ex.status) : ''}</td></tr>`).join('');
  // recent alerts
  const alerts = [];
  for (const r of S.runs) { if (!S.ds[r.ds]) continue; for (const a of r.alerts || []) alerts.push({ r, a }); }
  alerts.sort((x, y) => y.r.at - x.r.at);
  const al = alerts.slice(0, 8).map(({ r, a }) => {
    const d = S.ds[r.ds];
    const t = a.k === 'file_drop' ? `File score fell ${a.d.toFixed(1)} pts to ${sc(a.to)}` : a.k === 'rules_drop' ? `Rules score fell ${a.d.toFixed(1)} pts to ${sc(a.to)}` : a.k === 'rule_drop' ? `${esc(ruleName(d, a.rule))}: pass rate down ${a.d.toFixed(1)} pts` : `Schema drift: ${a.n} column change${a.n > 1 ? 's' : ''}`;
    const col = a.k === 'drift' ? 'var(--warn)' : 'var(--crit)';
    return `<li><span class="dot" style="background:${col};box-shadow:0 0 6px ${col};margin-top:5px"></span><span>${a.k === 'rule_drop' ? t : esc(t)} <span class="fine">· ${esc(d.name)}</span></span><span class="when">${esc(when(r.at))}</span></li>`;
  }).join('');
  el.innerHTML = `
    <section class="panel"><div class="ph"><h2>Data quality overview</h2><span class="hint">${anySample ? 'includes sample history, labelled' : 'from saved runs'}</span></div>${kpis}</section>
    <div class="dgrid">
      <section class="panel"><div class="ph"><h2>Datasets</h2><span class="hint">latest run and trend</span></div><div class="dscards">${cards}</div></section>
      <section class="panel"><div class="ph"><h2>Open exceptions by age</h2><span class="hint">select a cell to work it</span></div>${act.length ? heat : '<div class="empty">No open exceptions.</div>'}</section>
    </div>
    <div class="dgrid">
      <section class="panel"><div class="ph"><h2>Top failing rules</h2><span class="hint">latest run, weighted by severity</span></div>${top ? `<div class="tscroll"><table class="tbl"><thead><tr><th></th><th>Rule</th><th class="num">Failing</th><th class="num">Pass rate</th><th>Last 14 runs</th><th>Exception</th></tr></thead><tbody>${top}</tbody></table></div>` : '<div class="empty">Every rule passed on the latest runs.</div>'}</section>
      <section class="panel"><div class="ph"><h2>Recent alerts</h2><span class="hint">drops past threshold, drift</span></div>${al ? `<ul class="alist">${al}</ul>` : '<div class="empty">No alerts yet.</div>'}</section>
    </div>`;
}
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.click[data-a]')) { e.preventDefault(); e.target.click(); } });

/* ---------- monitoring ---------- */
function renderMonitor() {
  const el = $('v-monitor'), list = dsList(), now = Date.now();
  if (!S.ready) { el.innerHTML = '<div class="panel"><div class="empty">Loading saved history…</div></div>'; return; }
  if (!list.length) { el.innerHTML = `<section class="panel"><div class="ph"><h2>Monitoring</h2></div><div class="empty">No monitored datasets yet.<br><br><button type="button" class="btn" data-a="monitor-new">Monitor a file</button></div></section>`; return; }
  if (!S.mon || !S.ds[S.mon]) S.mon = (S.cur && S.cur.match && S.ds[S.cur.match.dataset.id]) ? S.cur.match.dataset.id : list[0].id;
  const ds = S.ds[S.mon], rs = runsOf(ds.id), lr = rs[rs.length - 1], pr = rs[rs.length - 2], th = Object.assign({}, O.DEFAULTS, ds.thresholds || {});
  const sel = `<label class="f"><span class="lbl">Dataset</span><select class="inp" id="monDs">${list.map(d => `<option value="${esc(d.id)}"${d.id === ds.id ? ' selected' : ''}>${esc(d.name)}${d.sample ? ' (sample)' : ''}</option>`).join('')}</select></label>`;
  const thr = `<label class="f"><span class="lbl">Alert when file score drops</span><span><input class="inp sm mono" id="thFile" type="number" min="0.5" max="50" step="0.5" value="${th.fileDrop}" style="width:80px"> points</span></label>
    <label class="f"><span class="lbl">Rules score drops</span><span><input class="inp sm mono" id="thRules" type="number" min="0.5" max="50" step="0.5" value="${th.rulesDrop}" style="width:80px"> points</span></label>
    <label class="f"><span class="lbl">A rule's pass rate drops</span><span><input class="inp sm mono" id="thRule" type="number" min="0.5" max="50" step="0.5" value="${th.ruleDrop}" style="width:80px"> points</span></label>`;
  const head = `<section class="panel"><div class="ph"><h2>Monitoring</h2><span class="hint">${rs.length} runs kept · ${esc(ds.ruleSet.name)} v${ds.ruleSet.version}</span></div>
    <div class="monhead">${sel}${thr}</div>
    <div class="kpis" style="margin-top:14px">
      <div class="kpi"><div class="lbl">File score</div><div class="v" style="color:${bandHex(lr && lr.fileScore)}">${lr ? sc(lr.fileScore) : '—'}</div><div class="s">${pr ? delta(pr.fileScore, lr.fileScore, ' pts') + ' vs previous' : 'first run'}</div></div>
      <div class="kpi"><div class="lbl">Rules score</div><div class="v" style="color:${bandHex(lr && lr.rulesScore)}">${lr ? sc(lr.rulesScore) : '—'}</div><div class="s">${pr ? delta(pr.rulesScore, lr.rulesScore, ' pts') + ' vs previous' : 'first run'}</div></div>
      <div class="kpi"><div class="lbl">Records passing all rules</div><div class="v">${lr ? pct(lr.rowsPassAll) : '—'}</div><div class="s">${lr ? nf0.format(lr.rows) + ' rows' : ''}</div></div>
      <div class="kpi ${lr && lr.alerts.length ? 'crit' : ''}"><div class="lbl">Alerts on last run</div><div class="v">${lr ? lr.alerts.length : 0}</div><div class="s">${lr ? esc(when(lr.at)) : ''}</div></div>
    </div>
    ${ds.sample ? '<p class="fine" style="margin-top:10px">Runs marked as sample history were generated to show how trends look over time. They are not real runs. Clear them from Schedules.</p>' : ''}
  </section>`;
  // per-rule table
  const ruleIds = O.activeRules(ds).map(r => r.id).concat(lr ? Object.keys(lr.per).filter(id => !O.activeRules(ds).some(r => r.id === id)) : []);
  const rr = ruleIds.map(id => {
    const hist = rs.slice(-20).map(r => r.per[id] ? r.per[id][0] : null);
    const a = pr && pr.per[id] ? pr.per[id][0] : null, b = lr && lr.per[id] ? lr.per[id] : null;
    const rule = ds.ruleSet.rules.find(r => r.id === id), sev = rule ? rule.severity : (b ? O.SEVS[b[3]] : 'low');
    const drop = a !== null && b && b[0] !== null ? (a - b[0]) * 100 : 0;
    return { id, sev, hist, a, b, drop, flagged: drop >= th.ruleDrop, err: b && b[4], name: ruleName(ds, id), ex: S.ex[O.exId(ds.id + '|rule|' + id)] };
  }).sort((x, y) => (y.flagged - x.flagged) || ((x.b && x.b[0] !== null ? x.b[0] : 2) - (y.b && y.b[0] !== null ? y.b[0] : 2)));
  const shown = S.monFlagged ? rr.filter(r => r.flagged) : rr;
  const rtable = `<div class="filters"><button type="button" class="chip" id="monFlag" aria-pressed="${S.monFlagged}">Flagged only (${rr.filter(r => r.flagged).length})</button></div>
    <div class="tscroll"><table class="tbl"><thead><tr><th></th><th>Rule</th><th class="num">Pass rate</th><th class="num">Change</th><th>Last ${Math.min(20, rs.length)} runs</th><th class="num">Failing</th><th></th></tr></thead><tbody>${shown.map(r => `<tr class="${r.ex ? 'click' : ''}" ${r.ex ? `data-a="open-ex" data-id="${esc(r.ex.id)}" tabindex="0"` : ''}>
      <td>${sevDot(r.sev)}</td><td style="min-width:200px">${esc(r.name)}${r.err ? ' <span class="pill hot">could not run</span>' : ''}${r.flagged ? ' <span class="pill hot">dropped</span>' : ''}</td>
      <td class="num">${r.b ? pct(r.b[0]) : '—'}</td><td class="num">${r.b ? delta(r.a, r.b[0], '') : ''}</td><td>${spark(r.hist, 110, 24, SEV_HEX[r.sev], { min: Math.min(0.9, ...r.hist.filter(v => v !== null)), max: 1 })}</td>
      <td class="num">${r.b ? nf0.format(r.b[1]) : '—'}</td><td>${r.ex ? pill(r.ex.status) : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="fine">No rules dropped past the threshold on the last run.</td></tr>'}</tbody></table></div>`;
  // run log
  const log = rs.slice().reverse(), lim = S.monAll ? log.length : 15;
  const rlog = `<div class="tscroll"><table class="tbl"><thead><tr><th>When</th><th>Kind</th><th class="num">Rows</th><th class="num">File</th><th class="num">Rules</th><th class="num">Pass all</th><th>Notes</th></tr></thead><tbody>${log.slice(0, lim).map((r, i) => {
    const p = log[i + 1];
    const notes = [];
    if (r.missed) notes.push(`caught up ${r.missed} missed`);
    for (const a of r.alerts) notes.push(a.k === 'file_drop' ? `<span class="down">file −${a.d.toFixed(1)}</span>` : a.k === 'rules_drop' ? `<span class="down">rules −${a.d.toFixed(1)}</span>` : a.k === 'drift' ? '<span style="color:var(--warn)">drift</span>' : '');
    const rd = r.alerts.filter(a => a.k === 'rule_drop').length; if (rd) notes.push(`<span class="down">${rd} rule${rd > 1 ? 's' : ''} dropped</span>`);
    if (r.rsv && p && p.rsv && r.rsv !== p.rsv) notes.push(`rule set v${r.rsv}`);
    return `<tr><td class="mono" style="white-space:nowrap">${esc(when(r.at))}</td><td>${r.kind === 'sample' ? '<span class="tag sample">Sample</span>' : esc(RUN_KIND[r.kind] || r.kind)}</td><td class="num">${nf0.format(r.rows)}</td>
      <td class="num" style="color:${bandHex(r.fileScore)}">${sc(r.fileScore)}</td><td class="num" style="color:${bandHex(r.rulesScore)}">${sc(r.rulesScore)}</td><td class="num">${pct(r.rowsPassAll)}</td><td>${notes.filter(Boolean).join(' · ')}</td></tr>`;
  }).join('')}</tbody></table></div>${log.length > 15 ? `<div class="erow end" style="margin-top:8px"><button type="button" class="mini" id="monAll">${S.monAll ? 'Show fewer' : 'Show all ' + log.length}</button></div>` : ''}`;
  // drift log
  const drifts = rs.filter(r => O.hasDrift(r.drift)).reverse();
  const dlog = drifts.length ? `<ul class="drift">${drifts.map(r => `<li><span class="when">${esc(when(r.at))}</span>${[
    r.drift.added.length ? `<span class="up">+ ${r.drift.added.map(esc).join(', ')}</span>` : '',
    r.drift.removed.length ? `<span class="down">− ${r.drift.removed.map(esc).join(', ')}</span>` : '',
    r.drift.typed.length ? `<span style="color:var(--warn)">${r.drift.typed.map(t => `${esc(t.c)}: ${esc(t.from)} → ${esc(t.to)}`).join(', ')}</span>` : ''].filter(Boolean).join(' · ')}</li>`).join('')}</ul>` : '<div class="empty">No column changes across the kept runs.</div>';
  const cur = ds.schema || (lr && lr.schema) || [];
  el.innerHTML = head + `
    <section class="panel"><div class="ph"><h2>Score trend</h2><span class="hint">drag across the chart to read a run</span></div><div class="chart" id="monChart"></div>
      <div class="legend"><span><i style="background:#5fe1ff"></i>File score</span><span><i style="background:#b48cff"></i>Rules score</span><span><i style="background:none;border-top:1px dashed #3dfcb4"></i>Good ${Math.round(DQ.SCORE.good * 100)}</span><span><i style="background:none;border-top:1px dashed #ffbe55"></i>Fair ${Math.round(DQ.SCORE.fair * 100)}</span><span style="color:var(--crit)">▼ drop alert</span><span style="color:var(--warn)">◆ schema drift</span></div></section>
    <div class="mgrid">
      <section class="panel"><div class="ph"><h2>Rule pass rates</h2><span class="hint">worst first</span></div>${rtable}</section>
      <section class="panel"><div class="ph"><h2>Schema drift</h2><span class="hint">${cur.length} columns now</span></div>${dlog}</section>
    </div>
    <section class="panel"><div class="ph"><h2>Run history</h2><span class="hint">newest first, last ${O.KEEP_RUNS} kept</span></div>${rlog}</section>`;
  drawChart(rs);
  $('monDs').onchange = e => { S.mon = e.target.value; renderMonitor(); };
  const saveTh = () => {
    const v = id => { const x = parseFloat($(id).value); return isFinite(x) && x > 0 ? Math.min(50, x) : null; };
    const t = { fileDrop: v('thFile') || th.fileDrop, rulesDrop: v('thRules') || th.rulesDrop, ruleDrop: v('thRule') || th.ruleDrop };
    put('datasets', Object.assign({}, ds, { thresholds: t })); toast('Alert thresholds saved. They apply from the next run.'); renderMonitor();
  };
  ['thFile', 'thRules', 'thRule'].forEach(id => { $(id).onchange = saveTh; });
  $('monFlag').onclick = () => { S.monFlagged = !S.monFlagged; renderMonitor(); };
  if ($('monAll')) $('monAll').onclick = () => { S.monAll = !S.monAll; renderMonitor(); };
}
function drawChart(rs) {
  const host = $('monChart'); if (!host) return;
  if (!rs.length) { host.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
  const W = Math.max(300, host.clientWidth || 800), H = W < 520 ? 200 : 250, L = 34, R = 12, T = 18, B = 26;
  const vals = rs.flatMap(r => [r.fileScore, r.rulesScore]).filter(v => v !== null);
  let lo = Math.min(...vals, DQ.SCORE.fair) - 0.03, hi = Math.min(1, Math.max(...vals, DQ.SCORE.good) + 0.02);
  lo = Math.max(0, Math.floor(lo * 20) / 20);
  const n = rs.length, X = i => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R)), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = key => { let d = '', pen = false; rs.forEach((r, i) => { const v = r[key]; if (v === null || v === undefined) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; pen = true; }); return d; };
  const grid = [];
  for (let v = Math.ceil(lo * 20) / 20; v <= hi + 1e-9; v += 0.05) grid.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="rgba(95,225,255,0.08)"/><text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" fill="#4f7690" font-size="10" font-family="JetBrains Mono, monospace">${Math.round(v * 100)}</text>`);
  const band = (v, col) => v >= lo && v <= hi ? `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${col}" stroke-dasharray="4 4" opacity="0.55"/>` : '';
  const sampleIdx = rs.map((r, i) => r.kind === 'sample' ? i : -1).filter(i => i >= 0);
  const shade = sampleIdx.length ? `<rect x="${X(sampleIdx[0]) - 4}" y="${T - 12}" width="${X(sampleIdx[sampleIdx.length - 1]) - X(sampleIdx[0]) + 8}" height="${H - T - B + 12}" fill="rgba(255,190,85,0.05)" stroke="rgba(255,190,85,0.25)" stroke-dasharray="2 4"/><text x="${X(sampleIdx[0]) + 2}" y="${T - 2}" fill="#ffbe55" font-size="10" letter-spacing="2" font-family="Chakra Petch, sans-serif">SAMPLE HISTORY</text>` : '';
  const ticks = []; const step = Math.max(1, Math.ceil(n / (W < 520 ? 4 : 8)));
  for (let i = 0; i < n; i += step) ticks.push(`<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="#4f7690" font-size="10" font-family="JetBrains Mono, monospace">${esc(df.format(new Date(rs[i].at)))}</text>`);
  const marks = rs.map((r, i) => {
    let m = '';
    if (r.alerts.some(a => a.k === 'file_drop' || a.k === 'rules_drop')) { const y = Y(Math.min(r.fileScore || hi, r.rulesScore || hi)) + 12; m += `<path d="M${(X(i) - 5).toFixed(1)} ${y.toFixed(1)} L${(X(i) + 5).toFixed(1)} ${y.toFixed(1)} L${X(i).toFixed(1)} ${(y + 8).toFixed(1)} Z" fill="#ff5a7a" style="filter:drop-shadow(0 0 4px #ff5a7a)"/>`; }
    if (O.hasDrift(r.drift)) m += `<rect x="${(X(i) - 4).toFixed(1)}" y="${(T - 4).toFixed(1)}" width="8" height="8" transform="rotate(45 ${X(i).toFixed(1)} ${T})" fill="#ffbe55"/>`;
    return m;
  }).join('');
  const pts = key => rs.map((r, i) => r[key] === null ? '' : `<circle cx="${X(i).toFixed(1)}" cy="${Y(r[key]).toFixed(1)}" r="${n > 40 ? 1.6 : 2.6}" fill="${key === 'fileScore' ? '#5fe1ff' : '#b48cff'}"/>`).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="File and rules score over ${n} runs">
    ${grid.join('')}${band(DQ.SCORE.good, '#3dfcb4')}${band(DQ.SCORE.fair, '#ffbe55')}${shade}
    <path d="${line('rulesScore')}" fill="none" stroke="#b48cff" stroke-width="2" style="filter:drop-shadow(0 0 5px #b48cff)"/>
    <path d="${line('fileScore')}" fill="none" stroke="#5fe1ff" stroke-width="2.2" style="filter:drop-shadow(0 0 6px #5fe1ff)"/>
    ${pts('rulesScore')}${pts('fileScore')}${marks}${ticks.join('')}
    <line id="mcX" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="rgba(214,244,255,0.5)" visibility="hidden"/>
  </svg>`;
  const svg = host.firstElementChild, cross = svg.querySelector('#mcX'), tip = $('tip');
  const near = e => { const b = svg.getBoundingClientRect(), x = (e.clientX - b.left) * (W / b.width); let k = 0, best = Infinity; rs.forEach((r, i) => { const d = Math.abs(X(i) - x); if (d < best) { best = d; k = i; } }); return k; };
  const showRun = e => {
    const i = near(e), r = rs[i], p = rs[i - 1];
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    const al = alertWords(r.alerts, S.ds[r.ds]);
    tip.innerHTML = `<b>${esc(when(r.at))}</b>${r.kind === 'sample' ? ' · sample' : ' · ' + esc(RUN_KIND[r.kind] || r.kind)}<br>File ${sc(r.fileScore)} ${p ? delta(p.fileScore, r.fileScore) : ''}<br>Rules ${sc(r.rulesScore)} ${p ? delta(p.rulesScore, r.rulesScore) : ''}<br>${nf0.format(r.rows)} rows${al ? '<br>' + esc(al) : ''}`;
    tip.hidden = false; const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8); tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  svg.addEventListener('pointermove', showRun); svg.addEventListener('pointerdown', showRun);
  svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}
let rzT = 0; addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { if (S.view === 'monitor') drawChart(runsOf(S.mon)); }, 150); });

/* ---------- exceptions ---------- */
function filteredEx() {
  const f = S.exf, now = Date.now(), q = f.q.trim().toLowerCase();
  return exList().filter(e => S.ds[e.ds]).filter(e => {
    if (f.status === 'active' ? !O.ACTIVE.has(e.status) : f.status !== 'all' && e.status !== f.status) return false;
    if (f.sev !== 'all' && e.sev !== f.sev) return false;
    if (f.ds !== 'all' && e.ds !== f.ds) return false;
    if (f.kind !== 'all' && e.kind !== f.kind) return false;
    if (f.age !== 'all' && O.ageBucket(O.ageOf(e, now)) !== f.age) return false;
    if (q && !(e.title + ' ' + (e.owner || '') + ' ' + (e.ruleId || '') + ' ' + (e.what || '') + ' ' + (e.samples || []).map(s => s.k).join(' ')).toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (O.ACTIVE.has(b.status) - O.ACTIVE.has(a.status)) || O.SEVS.indexOf(a.sev) - O.SEVS.indexOf(b.sev) || a.first - b.first);
}
function renderExceptions() {
  const el = $('v-exceptions'), f = S.exf, now = Date.now();
  if (!S.ready) { el.innerHTML = '<div class="panel"><div class="empty">Loading saved history…</div></div>'; return; }
  const all = exList().filter(e => S.ds[e.ds]), list = filteredEx();
  for (const id of [...S.sel]) if (!list.some(e => e.id === id)) S.sel.delete(id);
  const cnt = s => s === 'active' ? all.filter(e => O.ACTIVE.has(e.status)).length : s === 'all' ? all.length : all.filter(e => e.status === s).length;
  const stChips = ['active', 'open', 'assigned', 'in_progress', 'resolved', 'waived', 'all'].map(s => `<button type="button" class="chip" data-st="${s}" aria-pressed="${f.status === s}">${s === 'active' ? 'Active' : s === 'all' ? 'All' : O.STATUS_LABEL[s]} ${cnt(s)}</button>`).join('');
  const sevChips = ['all'].concat(O.SEVS).map(s => `<button type="button" class="chip" data-sv="${s}" aria-pressed="${f.sev === s}">${s === 'all' ? 'Any severity' : SEV_LABEL[s]}</button>`).join('');
  const dsSel = `<select class="inp sm" id="exDs" aria-label="Dataset"><option value="all">All datasets</option>${dsList().map(d => `<option value="${esc(d.id)}"${f.ds === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
  const kindSel = `<select class="inp sm" id="exKind" aria-label="Kind"><option value="all">All kinds</option>${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}"${f.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
  const ageSel = `<select class="inp sm" id="exAge" aria-label="Age"><option value="all">Any age</option>${O.AGE_BUCKETS.map(b => `<option value="${b.k}"${f.age === b.k ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}</select>`;
  const nSel = S.sel.size;
  const bar = `<div class="exbar" role="group" aria-label="Bulk actions">
      <label class="cb"><input type="checkbox" id="exAll" ${list.length && nSel === list.length ? 'checked' : ''} ${list.length ? '' : 'disabled'}> <span class="count">${nSel ? nSel + ' selected' : 'Select all ' + list.length}</span></label>
      <input class="inp sm" id="bOwner" type="text" maxlength="80" placeholder="Owner" aria-label="Owner for selected" style="width:150px">
      <button type="button" class="mini" id="bAssign" ${nSel ? '' : 'disabled'}>Assign</button>
      <select class="inp sm" id="bStatus" aria-label="Status for selected"><option value="">Set status…</option>${O.STATUSES.map(s => `<option value="${s}">${O.STATUS_LABEL[s]}</option>`).join('')}</select>
      <input class="inp sm" id="bReason" type="text" maxlength="400" placeholder="Waiver reason or note" aria-label="Waiver reason or note" style="flex:1 1 180px">
      <button type="button" class="mini" id="bApply" ${nSel ? '' : 'disabled'}>Apply</button>
      <button type="button" class="mini" id="bNote" ${nSel ? '' : 'disabled'}>Add as note</button>
      <button type="button" class="mini" id="bCsv" ${list.length ? '' : 'disabled'}>Export CSV${nSel ? ' (selected)' : ''}</button>
    </div><div class="eerr" id="bErr" role="alert"></div>`;
  const rows = list.map(e => exRow(e, now)).join('');
  el.innerHTML = `<section class="panel"><div class="ph"><h2>Exception queue</h2><span class="hint">one exception per failing rule, drift or score drop, kept across runs</span></div>
    <div class="exfilters"><div class="filters" style="margin:0">${stChips}</div></div>
    <div class="exfilters"><div class="filters" style="margin:0">${sevChips}</div>${dsSel}${kindSel}${ageSel}<input class="inp sm" id="exQ" type="search" placeholder="Search title, owner, key" value="${esc(f.q)}" aria-label="Search exceptions" style="flex:1 1 160px"></div>
    ${bar}
    ${list.length ? `<ul class="exlist">${rows}</ul>` : `<div class="empty">${all.length ? 'No exceptions match these filters.' : 'No exceptions yet. They appear when a monitored run finds failing rules, column changes or score drops.'}</div>`}
    <div class="sqlbox" id="csvBox" hidden><div class="erow"><span class="note grow">Copy the CSV below.</span><button type="button" class="btn ghost" id="csvClose">Close</button></div><textarea class="codebox mono" rows="8" readonly></textarea></div>
  </section>`;
  wireExceptions(list);
}
function exRow(e, now) {
  const ds = S.ds[e.ds], open = S.openEx === e.id, age = O.ageOf(e, now);
  const trend = e.kind === 'rule' && e.prevFailed !== null && e.prevFailed !== undefined && e.prevFailed !== e.failed ? (e.failed > e.prevFailed ? `<span class="down">▲ ${nf0.format(e.failed - e.prevFailed)}</span>` : `<span class="up">▼ ${nf0.format(e.prevFailed - e.failed)}</span>`) : '';
  const meta = [esc(ds.name), esc(KIND_LABEL[e.kind] || e.kind), e.kind === 'rule' ? `${nf0.format(e.failed)} failing of ${nf0.format(e.checked)} (${pct(e.rate)}) ${trend}` : esc(e.what || ''), `seen in ${e.runs || 1} run${(e.runs || 1) > 1 ? 's' : ''}`];
  const flags = [e.reopened ? `<span class="pill hot">reopened ×${e.reopened}</span>` : '', e.growing ? '<span class="pill hot">growing since waived</span>' : '', e.sample ? '<span class="tag sample">Sample</span>' : ''].join('');
  return `<li class="exrow ${esc(e.sev)}${open ? ' isopen' : ''}" data-exrow="${esc(e.id)}">
    <label class="cb" aria-label="Select"><input type="checkbox" data-sel="${esc(e.id)}" ${S.sel.has(e.id) ? 'checked' : ''}></label>
    ${sevDot(e.sev)}
    <button type="button" class="exmain" data-tog="${esc(e.id)}" aria-expanded="${open}"><span class="t">${esc(e.title)}</span><span class="m">${meta.join('<span>·</span>')}</span></button>
    <div class="exright">${flags}${pill(e.status)}<span>${e.owner ? esc(e.owner) : '<span class="fine">no owner</span>'}</span><span class="mono" title="Age since first seen">${O.fmtAge(age)}</span></div>
    ${open ? exDetail(e, ds, now) : ''}
  </li>`;
}
function exDetail(e, ds, now) {
  const loaded = loadedFor(ds) && e.kind === 'rule' && window.HoloSpace;
  const samples = e.kind === 'rule' && e.samples && e.samples.length ? `<div class="tscroll"><table class="tbl"><thead><tr><th>${esc(e.keyCol || 'Record')}</th><th class="num">Row</th>${(e.samples[0].v || []).map(v => `<th>${esc(v[0])}</th>`).join('')}</tr></thead><tbody>${e.samples.map(s => `<tr><td class="mono">${esc(s.k)}</td><td class="num">${s.row}</td>${(s.v || []).map(v => `<td class="mono">${v[1] === '' ? '<span class="fine">blank</span>' : esc(v[1])}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="fine">First ${e.samples.length} failing records from the latest run. Only these keys and values are saved, not the file.</p>` : e.kind === 'rule' ? '<p class="fine">No failing records on the latest run.</p>' : '';
  const notes = (e.notes || []).slice().reverse().map(n => `<div class="n"><span class="when">${esc(when(n.at))}${n.by ? ' · ' + esc(n.by) : ''}</span>${esc(n.t)}</div>`).join('');
  const log = (e.log || []).slice().reverse().map(l => `<li><span class="when">${esc(when(l.at))}</span>${esc(l.t)}</li>`).join('');
  const until = e.waiveUntil ? new Date(e.waiveUntil).toISOString().slice(0, 10) : '';
  return `<div class="exdetail">
    <div class="exdgrid">
      <div style="display:grid;gap:10px;min-width:0">
        <div><div class="lbl">What failed</div><div>${esc(e.what || e.title)}</div><div class="fine">First seen ${esc(when(e.first))} · last seen ${esc(when(e.last))}${e.resolvedAt ? ' · resolved ' + esc(when(e.resolvedAt)) + (e.resolvedBy === 'auto' ? ' automatically' : '') : ''}${e.waiveReason && e.status === 'waived' ? '<br>Waived: ' + esc(e.waiveReason) + (until ? ' (until ' + esc(until) + ')' : '') : ''}</div></div>
        ${samples}
        ${loaded ? `<div><button type="button" class="mini" data-space="${esc(e.ruleId)}">Show failing rows in holo space</button></div>` : ''}
      </div>
      <div style="display:grid;gap:10px;min-width:0">
        <div class="exctl">
          <label class="f"><span class="lbl">Owner</span><input class="inp" data-f="owner" type="text" maxlength="80" value="${esc(e.owner || '')}" placeholder="Name or team"></label>
          <label class="f"><span class="lbl">Status</span><select class="inp" data-f="status">${O.STATUSES.map(s => `<option value="${s}"${s === e.status ? ' selected' : ''}>${O.STATUS_LABEL[s]}</option>`).join('')}</select></label>
          <label class="f" data-waive ${e.status === 'waived' ? '' : 'hidden'}><span class="lbl">Waiver reason</span><input class="inp" data-f="reason" type="text" maxlength="400" value="${esc(e.waiveReason || '')}" placeholder="Why this is accepted"></label>
          <label class="f" data-waive ${e.status === 'waived' ? '' : 'hidden'}><span class="lbl">Waive until (optional)</span><input class="inp" data-f="until" type="date" value="${esc(until)}"></label>
        </div>
        <label class="f"><span class="lbl">Add a note</span><textarea class="inp" data-f="note" rows="2" maxlength="1000" placeholder="What you found or did"></textarea></label>
        <div class="erow end"><span class="eerr grow" data-err role="alert"></span><button type="button" class="btn" data-save="${esc(e.id)}">Save</button></div>
        ${notes ? `<div><div class="lbl" style="margin-bottom:4px">Notes</div><div class="notes">${notes}</div></div>` : ''}
        <div><div class="lbl" style="margin-bottom:6px">History</div><ul class="log">${log}</ul></div>
      </div>
    </div>
  </div>`;
}
function wireExceptions(list) {
  const el = $('v-exceptions'), now = () => Date.now();
  el.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { S.exf.status = b.dataset.st; renderExceptions(); });
  el.querySelectorAll('[data-sv]').forEach(b => b.onclick = () => { S.exf.sev = b.dataset.sv; renderExceptions(); });
  $('exDs').onchange = e => { S.exf.ds = e.target.value; renderExceptions(); };
  $('exKind').onchange = e => { S.exf.kind = e.target.value; renderExceptions(); };
  $('exAge').onchange = e => { S.exf.age = e.target.value; renderExceptions(); };
  let qT = 0; $('exQ').oninput = e => { clearTimeout(qT); const v = e.target.value; qT = setTimeout(() => { S.exf.q = v; renderExceptions(); const q = $('exQ'); q.focus(); q.setSelectionRange(v.length, v.length); }, 220); };
  $('exAll').onchange = e => { if (e.target.checked) list.forEach(x => S.sel.add(x.id)); else S.sel.clear(); renderExceptions(); };
  el.querySelectorAll('[data-sel]').forEach(c => c.onchange = () => { if (c.checked) S.sel.add(c.dataset.sel); else S.sel.delete(c.dataset.sel); renderExceptions(); });
  el.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => { S.openEx = S.openEx === b.dataset.tog ? null : b.dataset.tog; renderExceptions(); const r = el.querySelector(`[data-tog="${CSS.escape(b.dataset.tog)}"]`); if (r) r.focus(); });
  el.querySelectorAll('[data-space]').forEach(b => b.onclick = () => window.HoloSpace && HoloSpace.open({ rule: b.dataset.space }));
  el.querySelectorAll('.exdetail select[data-f="status"]').forEach(s => s.onchange = () => { s.closest('.exdetail').querySelectorAll('[data-waive]').forEach(w => w.hidden = s.value !== 'waived'); });
  el.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
    const box = b.closest('.exdetail'), g = k => box.querySelector(`[data-f="${k}"]`), ex = S.ex[b.dataset.save], err = box.querySelector('[data-err]');
    const st = g('status').value, untilV = g('until').value;
    const a = { owner: g('owner').value, note: g('note').value };
    if (st !== ex.status) a.status = st;
    if (st === 'waived') { a.status = 'waived'; a.reason = g('reason').value; a.until = untilV ? new Date(untilV + 'T23:59:59').getTime() : null; }
    try { const nx = O.act(ex, a, now()); put('exceptions', nx); err.textContent = ''; toast('Exception updated.'); renderBadges(); renderExceptions(); }
    catch (e) { err.textContent = e.message; }
  });
  const bulk = (fn, label) => {
    const err = $('bErr'); let ok = 0, bad = 0, msg = '';
    for (const id of S.sel) { const ex = S.ex[id]; if (!ex) continue; try { put('exceptions', O.act(ex, fn(ex), now())); ok++; } catch (e) { bad++; msg = e.message; } }
    err.textContent = bad ? `${bad} not changed: ${msg}` : '';
    if (ok) toast(`${label} ${ok} exception${ok > 1 ? 's' : ''}.`);
    renderBadges(); renderExceptions();
    if (bad) $('bErr').textContent = `${bad} not changed: ${msg}`;
  };
  $('bAssign').onclick = () => { const o = $('bOwner').value.trim(); if (!o) { $('bErr').textContent = 'Type an owner first.'; return; } bulk(ex => ({ owner: o, status: ex.status === 'open' || ex.status === 'resolved' ? 'assigned' : undefined }), 'Assigned'); };
  $('bApply').onclick = () => { const s = $('bStatus').value, r = $('bReason').value; if (!s) { $('bErr').textContent = 'Pick a status first.'; return; } if (s === 'waived' && !r.trim()) { $('bErr').textContent = 'A waiver needs a reason. Type it in the reason box.'; return; } bulk(() => ({ status: s, reason: r, note: s === 'waived' ? '' : r }), 'Updated'); };
  $('bNote').onclick = () => { const r = $('bReason').value.trim(); if (!r) { $('bErr').textContent = 'Type the note in the reason box first.'; return; } bulk(() => ({ note: r }), 'Added a note to'); };
  $('bCsv').onclick = () => {
    const rows = S.sel.size ? list.filter(e => S.sel.has(e.id)) : list;
    offer('dq_exceptions_' + new Date().toISOString().slice(0, 10) + '.csv', O.exceptionsCSV(rows, S.ds, now()), $('csvBox'));
  };
  $('csvClose').onclick = () => { $('csvBox').hidden = true; };
}

/* ---------- schedules ---------- */
function schedFields(prefix, sch) {
  const p2 = n => String(n).padStart(2, '0');
  return `<label class="f"><span class="lbl">Cadence</span><select class="inp" id="${prefix}Cad">${Object.entries(O.CADENCES).map(([k, v]) => `<option value="${k}"${sch.cadence === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <label class="f" data-cad="daily weekly"><span class="lbl">Time</span><input class="inp" id="${prefix}Time" type="time" value="${p2(sch.hour | 0)}:${p2(sch.minute | 0)}"></label>
    <label class="f" data-cad="hourly"><span class="lbl">Minute past the hour</span><input class="inp mono" id="${prefix}Min" type="number" min="0" max="59" value="${sch.minute | 0}"></label>
    <label class="f" data-cad="weekly"><span class="lbl">Day</span><select class="inp" id="${prefix}Dow">${O.DOW.map((d, i) => `<option value="${i}"${(sch.dow | 0) === i ? ' selected' : ''}>${d}</option>`).join('')}</select></label>`;
}
function syncCad(prefix) { const c = $(prefix + 'Cad'); if (!c) return; const v = c.value; document.querySelectorAll(`#v-schedules [data-cad]`).forEach(el => { if (el.querySelector('[id^="' + prefix + '"]')) el.hidden = !el.dataset.cad.split(' ').includes(v); }); }
function readSched(prefix, prev) {
  const cad = $(prefix + 'Cad').value, t = ($(prefix + 'Time').value || '07:00').split(':');
  const minute = cad === 'hourly' ? Math.max(0, Math.min(59, parseInt($(prefix + 'Min').value, 10) || 0)) : parseInt(t[1], 10) || 0;
  return { cadence: cad, hour: parseInt(t[0], 10) || 0, minute, dow: parseInt($(prefix + 'Dow').value, 10) || 0, since: prev && prev.cadence === cad && prev.hour === (parseInt(t[0], 10) || 0) && prev.minute === minute ? prev.since : Date.now() };
}
function renderSchedules() {
  const el = $('v-schedules'), now = Date.now(), list = dsList(), c = S.cur;
  if (!S.ready) { el.innerHTML = '<div class="panel"><div class="empty">Loading saved history…</div></div>'; return; }
  const canNew = c && c.p && !c.match;
  const stem = c ? O.stemOf(c.src.name) : '';
  const nRules = consoleRules().filter(r => r.status !== 'rejected').length;
  const form = c && c.p ? (canNew ? `<section class="panel"><div class="ph"><h2>Monitor the loaded file</h2><span class="hint">${esc(c.src.name)}</span></div>
      <div class="egrid">
        <label class="f"><span class="lbl">Dataset name</span><input class="inp" id="nmName" type="text" maxlength="80" value="${esc(titleCase(stem))}"></label>
        <label class="f"><span class="lbl">Rule set name</span><input class="inp" id="nmSet" type="text" maxlength="80" value="${esc(titleCase(stem))} rules"></label>
        ${schedFields('nm', { cadence: 'daily', hour: 7, minute: 0, dow: 1 })}
      </div>
      <p class="fine" style="margin-top:10px">Saves the ${nRules} rules in the rule console (rejected ones left out) as version 1, records a baseline run now, and matches later files named like <span class="mono">${esc(stem)}</span> (dates in the name are ignored) or with the same columns.</p>
      <div class="erow end"><span class="eerr grow" id="nmErr" role="alert"></span><button type="button" class="btn" id="nmGo" ${nRules ? '' : 'disabled'}>Start monitoring</button></div>
    </section>` : '') : `<section class="panel"><div class="empty">Load a file on the Profile tab to start monitoring it.</div></section>`;
  const items = list.map(d => {
    const st = O.scheduleState(d, now), lr = lastRun(d.id), ld = loadedFor(d), differ = ld && !O.sameRules(consoleRules(), d.ruleSet.rules);
    const stTxt = st.cadence === 'off' ? '<span class="state">Paused</span>' : st.onLoad ? '<span class="state ok">Runs each time the file is loaded</span>' : st.due ? `<span class="state due">Due since ${esc(when(st.dueSince))}${st.missed ? ` · ${st.missed} missed run${st.missed > 1 ? 's' : ''} will be caught up as one` : ''}</span>` : `<span class="state ok">Next run ${esc(when(st.next))} (${esc(rel(st.next, now))})</span>`;
    const pid = 'sc' + O.hash(d.id);
    const taskOpen = S.taskBox === d.id;
    return `<article class="sch" data-dsid="${esc(d.id)}">
      <div class="top"><h3>${esc(d.name)} ${d.sample ? '<span class="tag sample">Sample</span>' : ''}</h3>${stTxt}</div>
      <div class="meta"><span>Rule set: <b>${esc(d.ruleSet.name)}</b> v${d.ruleSet.version}, ${d.ruleSet.rules.length} rules</span><span>Matches files like <span class="mono">${esc(d.stem)}</span></span><span>Last run: ${lr ? esc(when(lr.at)) + ' · ' + esc(RUN_KIND[lr.kind] || lr.kind) : 'never'}</span><span>${d.runCount || 0} runs</span>${d.ruleSetMissing ? '<span style="color:var(--crit)">Part of this rule set did not load. Load the file and save the console rules to the set again.</span>' : ''}${ld ? '<span style="color:var(--good)">File loaded now</span>' : `<span>Load <span class="mono">${esc(d.lastFile || d.file)}</span> to run</span>`}</div>
      <div class="egrid">${schedFields(pid, d.schedule)}</div>
      <div class="acts">
        <button type="button" class="btn" data-a="run" data-ds="${esc(d.id)}" ${ld ? '' : 'disabled'} title="${ld ? '' : 'Load this file first'}">Run now</button>
        ${differ ? `<button type="button" class="btn ghost" data-a="save-rules" data-ds="${esc(d.id)}">Save console rules as v${d.ruleSet.version + 1}</button>` : ''}
        ${ld ? `<button type="button" class="btn ghost" data-a="load-rules" data-ds="${esc(d.id)}" ${differ ? '' : 'disabled'}>Use saved set in console</button>` : ''}
        <button type="button" class="btn ghost" data-task="${esc(d.id)}" aria-expanded="${taskOpen}">Snowflake task</button>
        <button type="button" class="btn ghost" data-ren="${esc(d.id)}">Rename</button>
        ${d.sample ? `<button type="button" class="btn ghost" data-clr="${esc(d.id)}">Clear sample history</button>` : ''}
        <button type="button" class="btn ghost" data-delds="${esc(d.id)}" style="${S.confirmDel === d.id ? 'color:var(--crit);border-color:var(--crit)' : ''}">${S.confirmDel === d.id ? 'Confirm: delete runs and exceptions' : 'Delete'}</button>
      </div>
      ${window.HoloSources && S.mode === 'server' ? HoloSources.cardRow(d) : ''}
      ${taskOpen ? taskBox(d) : ''}
    </article>`;
  }).join('');
  const sampleGone = S.meta.state && S.meta.state.cleared && !list.some(d => d.sample) && c && c.src.kind === 'sample';
  el.innerHTML = `
    ${window.HoloSources && S.mode === 'server' ? HoloSources.callout() : `<div class="callout"><b>How schedules run here.</b> A page can't run while it's closed. Each schedule is checked whenever this page is open: when you load or re-drop a matching file and a run is due, it runs then, and any slots missed while the page was closed are caught up as one run and noted in the history. For true background runs you need a server or Snowflake; <b>Snowflake task</b> exports the same rule set as a scheduled TASK you can run there.</div>`}
    ${form}
    <section class="panel"><div class="ph"><h2>Monitored datasets</h2><span class="hint">times in ${esc(tz)}</span></div>
      ${list.length ? `<div class="schlist">${items}</div>` : '<div class="empty">No monitored datasets yet.</div>'}
      ${sampleGone ? '<div class="erow" style="margin-top:12px"><button type="button" class="mini" id="reSample">Rebuild sample history</button></div>' : ''}
    </section>
    ${window.HoloSources && S.mode === 'server' ? HoloSources.panel() : ''}`;
  // wire
  if ($('nmGo')) {
    syncCad('nm'); $('nmCad').onchange = () => syncCad('nm');
    $('nmGo').onclick = () => {
      const name = $('nmName').value.trim(), set = $('nmSet').value.trim();
      if (!name) { $('nmErr').textContent = 'Give the dataset a name.'; return; }
      const sch = readSched('nm', null);
      const ds = O.newDataset({ name, file: c.src.name, headers: c.headers, rules: consoleRules(), keyCol: c.keyCol, ruleSetName: set || name + ' rules', schedule: sch, now: Date.now() });
      put('datasets', ds);
      c.match = { dataset: ds, byName: true, bySchema: true };
      const r = recordRun(ds, 'baseline', 0);
      const exN = activeEx().filter(e => e.ds === ds.id).length;
      c.note = `Baseline run recorded: file ${sc(r.fileScore)}, rules ${sc(r.rulesScore)}, ${exN} exception${exN === 1 ? '' : 's'} opened.`;
      toast(`Monitoring ${name}. ${c.note}`);
      renderAll();
    };
  }
  for (const d of list) {
    const pid = 'sc' + O.hash(d.id); syncCad(pid);
    const save = () => { const sch = readSched(pid, d.schedule); put('datasets', Object.assign({}, S.ds[d.id], { schedule: sch })); toast(`${d.name}: ${O.describeSchedule(sch)}.`); renderBadges(); renderStrip(); renderSchedules(); };
    [pid + 'Cad', pid + 'Time', pid + 'Min', pid + 'Dow'].forEach(id => { const x = $(id); if (x) x.onchange = save; });
  }
  el.querySelectorAll('[data-task]').forEach(b => b.onclick = () => { S.taskBox = S.taskBox === b.dataset.task ? null : b.dataset.task; renderSchedules(); });
  el.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
    const d = S.ds[b.dataset.ren], card = b.closest('.sch'), h = card.querySelector('h3');
    h.innerHTML = `<input class="inp" type="text" maxlength="80" value="${esc(d.name)}" aria-label="Dataset name" style="max-width:320px">`;
    const inp = h.firstElementChild; inp.focus(); inp.select();
    const done = ok => { const v = inp.value.trim(); if (ok && v && v !== d.name) { put('datasets', Object.assign({}, d, { name: O.clip(v, 80) })); toast('Renamed.'); } renderAll(); };
    inp.onkeydown = e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  });
  el.querySelectorAll('[data-clr]').forEach(b => b.onclick = () => { clearSample(S.ds[b.dataset.clr], false); toast('Sample history cleared.'); });
  if ($('reSample')) $('reSample').onclick = () => { if (S.cur && S.cur.src.kind === 'sample') { seedSample(); S.cur.match = O.matchDataset(dsList(), S.cur.src.name, S.cur.headers); renderAll(); toast('Sample history rebuilt.'); } };
  el.querySelectorAll('[data-delds]').forEach(b => b.onclick = () => {
    const id = b.dataset.delds;
    if (S.confirmDel !== id) { S.confirmDel = id; renderSchedules(); const nb = el.querySelector(`[data-delds="${CSS.escape(id)}"]`); if (nb) nb.focus(); return; }
    S.confirmDel = null; const d = S.ds[id];
    if (d.sample) { clearSample(d, false); toast('Sample history deleted.'); return; }
    for (const r of runsOf(id)) del('runs', r.id);
    for (const e of exList().filter(e => e.ds === id)) del('exceptions', e.id);
    del('datasets', id);
    if (S.cur && S.cur.match && S.cur.match.dataset.id === id) S.cur.match = null;
    toast(`Deleted ${d.name} with its runs and exceptions.`); renderAll();
  });
  if (S.taskBox && S.ds[S.taskBox]) wireTask(S.ds[S.taskBox]);
  if (window.HoloSources && S.mode === 'server') HoloSources.wire(el);
}
function taskBox(d) {
  const t = S.taskTable || '', w = S.taskWh || 'DQ_WH';
  return `<div class="sqlbox" id="taskBox">
    <div class="erow"><label class="f grow"><span class="lbl">Snowflake table the file lands in</span><input id="tkTable" type="text" class="mono" spellcheck="false" placeholder="DB.SCHEMA.TABLE" value="${esc(t)}"></label>
      <label class="f"><span class="lbl">Warehouse</span><input id="tkWh" type="text" class="mono" spellcheck="false" value="${esc(w)}"></label></div>
    <div class="erow"><button type="button" class="btn" id="tkCopy">Copy SQL</button><button type="button" class="btn ghost" id="tkSave">Save as text file</button><span class="note grow" id="tkMsg" aria-live="polite">Runs ${esc(O.describeSchedule(d.schedule.cadence === 'off' || d.schedule.cadence === 'load' ? { cadence: 'daily', hour: 7, minute: 0 } : d.schedule).toLowerCase())} in ${esc(tz)} and appends one row per rule to DQ_RULE_RESULTS.</span></div>
    <textarea id="tkText" class="codebox mono" rows="14" readonly spellcheck="false"></textarea>
  </div>`;
}
function wireTask(d) {
  const gen = () => { S.taskTable = $('tkTable').value; S.taskWh = $('tkWh').value; $('tkText').value = O.snowflakeTaskSQL(d, { table: $('tkTable').value || (d.stem || 'TABLE').toUpperCase(), warehouse: $('tkWh').value, tz }); };
  gen();
  $('tkTable').oninput = gen; $('tkWh').oninput = gen;
  $('tkCopy').onclick = async () => { try { await navigator.clipboard.writeText($('tkText').value); $('tkMsg').textContent = 'Copied.'; } catch (e) { $('tkText').focus(); $('tkText').select(); $('tkMsg').textContent = 'Press Ctrl+C or Cmd+C to copy the selected SQL.'; } };
  $('tkSave').onclick = () => offer(('dq_task_' + (d.stem || 'dataset')).replace(/[^A-Za-z0-9_-]+/g, '_') + '.txt', $('tkText').value, null);
}

/* ---------- ticking: keep due states fresh while the page is open ---------- */
// Hosted app: fold in runs and exception changes the server scheduler made since the page loaded.
let reloading = false;
async function reloadFromServer(force) {
  if (S.mode !== 'server' || reloading || (!force && (queue.size || draining))) return false;
  reloading = true;
  try {
    const data = await SRV.store.load();
    if (!force && (queue.size || draining)) return false;
    intakeAll(data);
    if (S.cur && S.cur.p) S.cur.match = O.matchDataset(dsList(), S.cur.src.name, S.cur.headers);
    renderStore(); renderBadges(); renderStrip();
    const box = document.getElementById('v-' + S.view);
    if (force || !(box && document.activeElement && box.contains(document.activeElement))) renderView();
    return true;
  } catch (e) { return false; } finally { reloading = false; }
}
setInterval(() => {
  const now = Date.now(); S.lastNow = now;
  if (!S.ready) return;
  if (S.mode === 'server') reloadFromServer(false);
  renderBadges(); renderStrip();
  if (S.view === 'schedules' && !document.activeElement.closest('#v-schedules')) renderSchedules();
  if (S.view === 'dash') renderDash();
}, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) { if (S.mode === 'server') reloadFromServer(false); renderBadges(); renderStrip(); } });

/* ---------- boot ---------- */
window.HoloOps = { fileLoaded, rulesChanged() { if (S.ready) renderStrip(); if (S.view === 'schedules') renderSchedules(); }, get state() { return S; }, show,
  put, toast, reload: reloadFromServer, renderAll, describeSchedule: O.describeSchedule, when, tz };
let start = 'profile'; try { start = localStorage.getItem('holo.ops.view') || 'profile'; } catch (e) { /* ignore */ }
show(start);
if (window.__holoLast) fileLoaded(window.__holoLast.p, window.__holoLast.rows, window.__holoLast.src);
initStore();
})();
