/* DQ rules engine: suggest rules from a profile, run them on rows, export JSON and Snowflake SQL. Pure functions, no DOM. */
(function (root) {
'use strict';
const DQ = root.DQ || (typeof require !== 'undefined' ? require('./engine.js') : null);

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEV_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };
const RULES_SCORE = { passShare: 0.5, rowShare: 0.5, critEach: 0.04, critMax: 0.20 };
const DAY = 86400000;

const TYPES = {
  not_null:       { label: 'Not null',        dim: 'completeness', cols: 1 },
  unique:         { label: 'Unique',          dim: 'uniqueness',   cols: 3 },
  format:         { label: 'Format',          dim: 'validity',     cols: 1 },
  allowed_values: { label: 'Allowed values',  dim: 'validity',     cols: 1 },
  range:          { label: 'Range',           dim: 'validity',     cols: 1 },
  compare:        { label: 'Compare columns', dim: 'consistency',  cols: 2 }
};

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const FORMATS = {
  email:    { label: 'Email address',            test: s => DQ.isEmail(s) },
  phone:    { label: 'Phone number',             test: s => DQ.isPhone(s) },
  zip:      { label: 'US ZIP (12345 or 12345-6789)', test: s => DQ.isZip(s) },
  state:    { label: 'US state code',            test: s => /^[A-Za-z]{2}$/.test(s) && DQ.isState(s) },
  date:     { label: 'Any valid date',           test: s => { const d = DQ.parseDate(s, true); return !!d && new Date(d.t).getUTCFullYear() >= 1900; } },
  date_iso: { label: 'Date as YYYY-MM-DD',       test: s => DATE_ISO.test(s) && !!DQ.parseDate(s, false) },
  uuid:     { label: 'UUID',                     test: s => DQ.isUuid(s) },
  url:      { label: 'Web address (http/https)', test: s => DQ.isUrl(s) },
  regex:    { label: 'Custom pattern (regex)',   test: null }
};
const FORMAT_PHRASE = { email: 'is a valid email address', phone: 'is a valid phone number', zip: 'is a valid ZIP code', state: 'is a valid US state code', date: 'is a valid date', date_iso: 'uses YYYY-MM-DD', uuid: 'is a valid UUID', url: 'is a valid web address' };
const OPS = { '>=': (a, b) => a >= b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '<': (a, b) => a < b, '=': (a, b) => a === b, '!=': (a, b) => a !== b };
const OP_WORDS = { '>=': 'on or after', '>': 'after', '<=': 'on or before', '<': 'before', '=': 'equal to', '!=': 'different from' };
const OP_WORDS_NUM = { '>=': 'at least', '>': 'greater than', '<=': 'at most', '<': 'less than', '=': 'equal to', '!=': 'different from' };

/* ---------- value helpers ---------- */
function isNull(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  const t = String(raw).trim();
  return t === '' || DQ.NULL_TOKENS.has(t.toLowerCase());
}
const val = raw => String(raw).trim();
const toNum = s => { const p = DQ.parseNum(s); return p ? p.v : null; };
const toDate = s => { const d = DQ.parseDate(s, true); return d ? d.t : null; };
function boundDate(b, now) {
  if (b === undefined || b === null || b === '') return null;
  if (String(b).trim().toLowerCase() === 'today') return now + DAY; // one day of grace for time zones
  return toDate(String(b));
}
function boundNum(b) { if (b === undefined || b === null || b === '') return null; const n = typeof b === 'number' ? b : toNum(String(b)); return n === null ? NaN : n; }
const fmtNum = v => { const a = Math.abs(v); return a >= 1e6 ? +(v / 1e6).toFixed(2) + 'M' : a >= 1e4 ? +(v / 1e3).toFixed(1) + 'K' : String(+v.toFixed(2)); };
function niceCeil(v) { if (!(v > 0)) return v; const p = Math.pow(10, Math.floor(Math.log10(v)) - 1); return Math.ceil(v / p) * p; }

/* ---------- validation ---------- */
function compileRegex(params) {
  try { return new RegExp(params.regex, (params.flags || '').replace(/[^i]/g, '')); } catch (e) { return null; }
}
function checkRule(rule, headers) {
  const errs = [];
  const t = TYPES[rule.type];
  if (!t) { errs.push('Unknown rule type "' + rule.type + '".'); return errs; }
  const cols = (rule.columns || []).filter(Boolean);
  if (!cols.length) errs.push('Pick a column.');
  if (rule.type === 'compare' && cols.length !== 2) errs.push('Pick two columns to compare.');
  if (rule.type !== 'unique' && rule.type !== 'compare' && cols.length > 1) errs.push('This rule type checks one column.');
  if (headers) for (const c of cols) if (headers.indexOf(c) < 0) errs.push('Column "' + c + '" is not in this file.');
  const p = rule.params || {};
  if (rule.type === 'format') {
    if (!FORMATS[p.format]) errs.push('Pick a format.');
    if (p.format === 'regex' && (!p.regex || !compileRegex(p))) errs.push('The pattern is not a valid regular expression.');
  }
  if (rule.type === 'allowed_values' && !(Array.isArray(p.values) && p.values.length)) errs.push('List at least one allowed value.');
  if (rule.type === 'range') {
    const kind = p.kind === 'date' ? 'date' : 'number';
    const lo = kind === 'date' ? boundDate(p.min, Date.now()) : boundNum(p.min), hi = kind === 'date' ? boundDate(p.max, Date.now()) : boundNum(p.max);
    const given = x => x !== undefined && x !== null && String(x).trim() !== '';
    if (!given(p.min) && !given(p.max)) errs.push('Set a minimum, a maximum or both.');
    if (given(p.min) && (lo === null || Number.isNaN(lo))) errs.push('The minimum is not a valid ' + kind + '.');
    if (given(p.max) && (hi === null || Number.isNaN(hi))) errs.push('The maximum is not a valid ' + kind + (kind === 'date' ? ' (use YYYY-MM-DD or "today")' : '') + '.');
    if (lo !== null && hi !== null && !Number.isNaN(lo) && !Number.isNaN(hi) && lo > hi) errs.push('The minimum is larger than the maximum.');
  }
  if (rule.type === 'compare' && !OPS[p.op]) errs.push('Pick a comparison.');
  if (rule.when) {
    if (!rule.when.column) errs.push('Pick the column for the condition.');
    else if (headers && headers.indexOf(rule.when.column) < 0) errs.push('Condition column "' + rule.when.column + '" is not in this file.');
    if (!(Array.isArray(rule.when.values) && rule.when.values.length)) errs.push('List the values the condition matches.');
  }
  if (!SEVERITIES.includes(rule.severity)) errs.push('Pick a severity.');
  return errs;
}

/* ---------- plain-language definition ---------- */
function describe(rule) {
  const c = rule.columns || [], p = rule.params || {};
  let s;
  switch (rule.type) {
    case 'not_null': s = `${c[0]} is filled`; break;
    case 'unique': s = p.blanksMatch ? `no two rows repeat all ${c.length} columns` : c.length > 3 ? `no two rows repeat all ${c.length} columns` : `${c.join(' + ')} is unique`; break;
    case 'format': s = p.format === 'regex' ? `${c[0]} matches /${p.regex}/${(p.flags || '').includes('i') ? 'i' : ''}` : `${c[0]} ${FORMAT_PHRASE[p.format] || 'has a valid format'}`; break;
    case 'allowed_values': { const v = p.values || []; s = `${c[0]} is one of ${v.slice(0, 6).map(x => '"' + x + '"').join(', ')}${v.length > 6 ? ` and ${v.length - 6} more` : ''}${p.caseSensitive === false ? ' (any case)' : ''}`; break; }
    case 'range': {
      const has = x => x !== undefined && x !== null && String(x).trim() !== '';
      const show = x => p.kind === 'date' ? String(x) : (typeof x === 'number' ? fmtNum(x) : String(x));
      if (has(p.min) && has(p.max)) s = String(p.min) === String(p.max) ? `${c[0]} equals ${show(p.min)}` : `${c[0]} is between ${show(p.min)} and ${show(p.max)}`;
      else if (has(p.min)) s = p.kind === 'date' ? `${c[0]} is on or after ${show(p.min)}` : `${c[0]} is at least ${show(p.min)}`;
      else s = p.kind === 'date' ? `${c[0]} is on or before ${show(p.max)}` : `${c[0]} is at most ${show(p.max)}`;
      break;
    }
    case 'compare': s = `${c[0]} is ${(p.kind === 'number' ? OP_WORDS_NUM : OP_WORDS)[p.op] || p.op} ${c[1]}`; break;
    default: s = rule.type;
  }
  if (rule.when) s = `when ${rule.when.column} is ${rule.when.values.map(x => '"' + x + '"').join(' or ')}, ${s}`;
  return s;
}

/* ---------- run ---------- */
function ruleKey(rule) { return JSON.stringify([rule.type, rule.columns, rule.params, rule.when || null]); }

function runRule(rule, ctx) {
  const headers = ctx.headers, rows = ctx.rows, n = rows.length, now = ctx.now || Date.now();
  const errs = checkRule(rule, headers);
  if (errs.length) return { id: rule.id, error: errs[0], checked: 0, failed: 0, passed: 0, passRate: null, failRows: [], samples: [] };
  const idx = rule.columns.map(c => headers.indexOf(c));
  const p = rule.params || {};
  let whenIdx = -1, whenSet = null;
  if (rule.when) { whenIdx = headers.indexOf(rule.when.column); whenSet = new Set(rule.when.values.map(v => String(v).trim().toLowerCase())); }
  let test = null;
  if (rule.type === 'format') {
    if (p.format === 'regex') { const re = compileRegex(p); test = s => re.test(s); } else test = FORMATS[p.format].test;
  } else if (rule.type === 'allowed_values') {
    const cs = p.caseSensitive !== false;
    const set = new Set(p.values.map(v => cs ? String(v).trim() : String(v).trim().toLowerCase()));
    test = s => set.has(cs ? s : s.toLowerCase());
  } else if (rule.type === 'range') {
    if (p.kind === 'date') { const lo = boundDate(p.min, now), hi = boundDate(p.max, now); test = s => { const t = toDate(s); return t !== null && (lo === null || t >= lo) && (hi === null || t <= hi); }; }
    else { const lo = boundNum(p.min), hi = boundNum(p.max); test = s => { const v = toNum(s); return v !== null && (lo === null || v >= lo) && (hi === null || v <= hi); }; }
  }
  const op = OPS[p.op], asDate = p.kind !== 'number';
  let checked = 0, failed = 0, outOfScope = 0, skippedNull = 0;
  const failRows = [], samples = [];
  const seen = rule.type === 'unique' ? new Map() : null;
  const sample = (r, extra) => { if (samples.length < 12) samples.push({ row: r, values: rule.columns.slice(0, 4).map((c, k) => ({ c, v: rows[r][idx[k]] === undefined ? '' : String(rows[r][idx[k]]) })), note: extra || '' }); };
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    if (whenIdx >= 0) { const w = row[whenIdx]; if (isNull(w) || !whenSet.has(val(w).toLowerCase())) { outOfScope++; continue; } }
    if (rule.type === 'not_null') {
      checked++;
      if (isNull(row[idx[0]])) { failed++; failRows.push(r); sample(r); }
      continue;
    }
    if (rule.type === 'unique' && p.blanksMatch) {
      const k = idx.map(i => row[i] === undefined || row[i] === null ? '' : val(row[i])).join('\u0001');
      checked++;
      if (seen.has(k)) { failed++; failRows.push(r); sample(r, 'repeats row ' + (seen.get(k) + 1)); } else seen.set(k, r);
      continue;
    }
    let anyNull = false; for (const i of idx) if (isNull(row[i])) { anyNull = true; break; }
    if (anyNull) { skippedNull++; continue; }
    if (rule.type === 'unique') {
      const k = idx.length === 1 ? val(row[idx[0]]) : idx.map(i => val(row[i])).join('\u0001');
      checked++;
      if (seen.has(k)) { failed++; failRows.push(r); sample(r, 'repeats row ' + (seen.get(k) + 1)); } else seen.set(k, r);
      continue;
    }
    if (rule.type === 'compare') {
      const a = val(row[idx[0]]), b = val(row[idx[1]]);
      const A = asDate ? toDate(a) : toNum(a), B = asDate ? toDate(b) : toNum(b);
      if (A === null || B === null) { skippedNull++; continue; }
      checked++;
      if (!op(A, B)) { failed++; failRows.push(r); sample(r); }
      continue;
    }
    checked++;
    if (!test(val(row[idx[0]]))) { failed++; failRows.push(r); sample(r); }
  }
  return { id: rule.id, checked, failed, passed: checked - failed, passRate: checked ? (checked - failed) / checked : null, outOfScope, skippedNull, failRows, samples };
}

function runRules(rules, ctx, cache) {
  const out = {};
  for (const rule of rules) {
    const k = ruleKey(rule);
    if (cache && cache.has(k)) { out[rule.id] = Object.assign({}, cache.get(k), { id: rule.id }); continue; }
    const res = runRule(rule, ctx);
    if (cache) cache.set(k, res);
    out[rule.id] = res;
  }
  return out;
}

/* Rules score: half the severity-weighted pass rate, half the share of rows that pass every rule,
   minus 4 points for each critical rule that fails at least one row (capped at 20). */
function scoreRules(rules, results, nRows) {
  const active = rules.filter(r => r.status !== 'rejected' && results[r.id] && !results[r.id].error);
  let wSum = 0, wPass = 0; const bySev = {}, byDim = {};
  for (const s of SEVERITIES) bySev[s] = { rules: 0, failing: 0 };
  const rowBad = new Uint8Array(nRows);
  let failingCritical = 0, passingRules = 0;
  for (const r of active) {
    const res = results[r.id];
    bySev[r.severity].rules++;
    if (res.failed) bySev[r.severity].failing++; else passingRules++;
    if (res.failed && r.severity === 'critical') failingCritical++;
    if (res.checked) { const w = SEV_WEIGHT[r.severity]; wSum += w; wPass += w * res.passRate; const d = TYPES[r.type].dim; byDim[d] = byDim[d] || { w: 0, p: 0, rules: 0 }; byDim[d].w += w; byDim[d].p += w * res.passRate; byDim[d].rules++; }
    for (const i of res.failRows) rowBad[i] = 1;
  }
  let bad = 0; for (let i = 0; i < nRows; i++) bad += rowBad[i];
  const weightedPass = wSum ? wPass / wSum : null;
  const rowsPassAll = nRows ? (nRows - bad) / nRows : null;
  const penalty = Math.min(RULES_SCORE.critMax, failingCritical * RULES_SCORE.critEach);
  const score = weightedPass === null ? null : Math.max(0, RULES_SCORE.passShare * weightedPass + RULES_SCORE.rowShare * (rowsPassAll === null ? weightedPass : rowsPassAll) - penalty);
  const dims = {}; for (const d of Object.keys(byDim)) dims[d] = { rate: byDim[d].p / byDim[d].w, rules: byDim[d].rules };
  return { score, weightedPass, rowsPassAll, rowsFailing: bad, failingCritical, penalty, passingRules, activeRules: active.length, bySev, dims };
}

/* ---------- suggestions ---------- */
function shapeRegex(shape) {
  let out = '', i = 0;
  const cls = { A: '[A-Z]', a: '[a-z]', '9': '[0-9]' };
  while (i < shape.length) {
    const ch = shape[i]; let j = i; while (j < shape.length && shape[j] === ch) j++;
    const k = j - i;
    if (cls[ch]) out += cls[ch] + (k > 1 ? '{' + k + '}' : '');
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').repeat(k);
    i = j;
  }
  return '^' + out + '$';
}

function suggestRules(p, opts) {
  opts = opts || {};
  let n = opts.startId || 1;
  const out = [];
  const add = (r) => { out.push(Object.assign({ id: 'R' + String(n++).padStart(3, '0'), status: 'suggested', origin: 'suggested' }, r)); };
  if (!p || !p.cols) return out;
  const pc = v => (v * 100).toFixed(v >= 0.999 ? 0 : 1) + '%';

  for (const c of p.cols) {
    if (!c.present) continue;
    const comp = c.dims.completeness;
    // completeness
    if (c.key) {
      add({ name: `${c.name} is always filled`, type: 'not_null', columns: [c.name], params: {}, severity: 'critical', description: `Every record needs a ${c.name}; it identifies the record.`, reason: `Likely key column, ${pc(comp)} filled today.` });
      add({ name: `${c.name} is unique`, type: 'unique', columns: [c.name], params: {}, severity: 'critical', description: `Each ${c.name} appears once. Repeats point to double-loaded or mis-keyed records.`, reason: `Likely key column, ${pc(c.distinctRatio)} distinct today.` });
    } else if (comp >= 0.9) {
      add({ name: `${c.name} is always filled`, type: 'not_null', columns: [c.name], params: {}, severity: comp >= 0.98 ? 'high' : 'medium', description: `${c.name} should not be blank or a placeholder such as N/A.`, reason: `${pc(comp)} filled today, so blanks look like gaps rather than an optional field.` });
    }
    // format by inferred type
    const fmtSev = { email: 'medium', phone: 'medium', zip: 'high', state: 'high', date: 'high', uuid: 'medium', url: 'low' };
    if (fmtSev[c.type]) {
      const f = c.type;
      add({ name: `${c.name} ${FORMAT_PHRASE[f]}`, type: 'format', columns: [c.name], params: { format: f }, severity: fmtSev[f], description: `Filled values must be: ${FORMATS[f].label}.`, reason: `Inferred as ${c.typeLabel}; ${pc(c.dims.validity || 0)} of filled values pass the profiler's check.` });
    }
    if (c.type === 'date' && c.formats && c.formats.length && c.formats[0].f === 'YYYY-MM-DD') {
      const tot = c.formats.reduce((a, f) => a + f.c, 0), share = c.formats[0].c / tot;
      if (share >= 0.9) add({ name: `${c.name} uses YYYY-MM-DD`, type: 'format', columns: [c.name], params: { format: 'date_iso' }, severity: 'low', description: `Dates should use one format so they load and sort the same way downstream.`, reason: `${pc(share)} of dates use YYYY-MM-DD today.` });
    }
    if (c.type === 'date' && c.hints.pastEvent) {
      add({ name: `${c.name} is not in the future`, type: 'range', columns: [c.name], params: { kind: 'date', min: '1900-01-01', max: 'today' }, severity: 'high', description: `${c.name} records something that already happened, so it cannot be after today.`, reason: `Event-style date column${c.date && c.date.future ? `; ${c.date.future} future dates today` : ''}.` });
    }
    // structured identifier pattern
    if (c.type === 'identifier' && c.topShapes && c.topShapes.length && c.topShapes[0].share >= 0.9 && c.topShapes[0].s !== 'long text' && /[^9]/.test(c.topShapes[0].s)) {
      const sh = c.topShapes[0].s;
      add({ name: `${c.name} matches ${sh}`, type: 'format', columns: [c.name], params: { format: 'regex', regex: shapeRegex(sh), flags: '' }, severity: 'medium', description: `Values follow the house pattern ${sh} (A is a capital letter, 9 is a digit).`, reason: `${pc(c.topShapes[0].share)} of values have this shape today.` });
    }
    // allowed values for low-cardinality text
    if ((c.categorical || c.type === 'boolean') && c.type !== 'state' && c.base !== 'number' && c.type !== 'date' && c.distinct <= 40) {
      const groups = new Map();
      let list = c.top.map(t => [t.v, t.c]);
      if (opts.rows && opts.headers) {
        const ci = opts.headers.indexOf(c.name), m = new Map();
        for (const row of opts.rows) { const x = row[ci]; if (isNull(x)) continue; const v = val(x); m.set(v, (m.get(v) || 0) + 1); }
        list = Array.from(m.entries());
      }
      for (const [v, k] of list) { const g = v.toLowerCase().replace(/\s+/g, ' ').trim(); const e = groups.get(g) || { forms: [], total: 0 }; e.forms.push([v, k]); e.total += k; groups.set(g, e); }
      const minK = Math.max(3, Math.ceil(c.present * 0.005));
      const keep = [], dropped = [];
      for (const e of groups.values()) { e.forms.sort((a, b) => b[1] - a[1]); (e.total >= minK ? keep : dropped).push(e); }
      keep.sort((a, b) => b.total - a.total);
      if (keep.length >= 2 && keep.length <= 30) {
        const values = keep.map(e => e.forms[0][0].trim());
        const variants = keep.reduce((a, e) => a + e.forms.length - 1, 0);
        const why = [`${keep.length} values cover most rows`];
        if (variants) why.push('case or spacing variants left out so they fail');
        if (dropped.length) why.push(`${dropped.length} rare value${dropped.length > 1 ? 's' : ''} left out (${dropped.slice(0, 3).map(e => '"' + e.forms[0][0] + '"').join(', ')})`);
        add({ name: `${c.name} uses an approved value`, type: 'allowed_values', columns: [c.name], params: { values, caseSensitive: true }, severity: 'medium', description: `${c.name} must be one of the approved values, spelled exactly.`, reason: why.join('; ') + '.' });
      }
    }
    // numeric ranges
    if (c.base === 'number' && c.num && c.hints.amount) {
      add({ name: `${c.name} is not negative`, type: 'range', columns: [c.name], params: { kind: 'number', min: 0 }, severity: 'high', description: `Amounts are recorded as zero or more; recoveries and reversals belong in their own fields.`, reason: c.num.negatives ? `${c.num.negatives} negative values today.` : 'Amount column.' });
      if (isFinite(c.num.fenceHi) && c.num.fenceHi > 0) {
        const hi = niceCeil(c.num.fenceHi);
        add({ name: `${c.name} is at most ${fmtNum(hi)}`, type: 'range', columns: [c.name], params: { kind: 'number', max: hi }, severity: 'low', description: `Values above ${fmtNum(hi)} are unusual for this file and worth a second look.`, reason: `Upper outlier fence (${c.num.outlierMethod}) is about ${fmtNum(c.num.fenceHi)}${c.num.outHigh ? `; ${c.num.outHigh} values above it today` : ''}.` });
      }
    }
  }
  // cross-column date order
  for (const rl of p.rules || []) {
    add({ name: `${rl.second} is on or after ${rl.first}`, type: 'compare', columns: [rl.second, rl.first], params: { op: '>=', kind: 'date' }, severity: 'high', description: `${rl.second} cannot come before ${rl.first}.`, reason: `${pc(1 - rl.rate)} of rows already follow this order.` });
  }
  // conditional zero amounts (e.g. closed claims carry no reserve)
  if (opts.rows && opts.headers) {
    const H = opts.headers, R = opts.rows;
    // Wide files can hold dozens of each, so look at the most promising pairs first (status-like
    // categories, reserve-like amounts) and stop after a fixed amount of row scanning.
    const catHint = c => /status|stage|state|closed|open|disposition/i.test(c.name) ? 0 : 1;
    const amtHint = c => /reserve|outstanding|open|balance/i.test(c.name) ? 0 : 1;
    const cats = p.cols.filter(c => c.categorical && c.distinct <= 12 && c.present >= 30).sort((x, y) => catHint(x) - catHint(y) || x.distinct - y.distinct);
    const amts = p.cols.filter(c => c.base === 'number' && c.hints.amount && c.num).sort((x, y) => amtHint(x) - amtHint(y));
    const pairs = []; for (const cat of cats) for (const a of amts) pairs.push([cat, a]);
    pairs.sort((x, y) => (catHint(x[0]) + amtHint(x[1])) - (catHint(y[0]) + amtHint(y[1])));
    const maxPairs = Math.max(1, Math.min(pairs.length, Math.floor(1.5e6 / Math.max(1, R.length))));
    let made = 0;
    for (const [cat, a] of pairs.slice(0, maxPairs)) {
      if (made >= 4) break;
      const stats = new Map(); const ci = H.indexOf(cat.name), ai = H.indexOf(a.name);
      for (const row of R) {
        if (isNull(row[ci]) || isNull(row[ai])) continue;
        const v = toNum(val(row[ai])); if (v === null) continue;
        const g = val(row[ci]).toLowerCase(); const e = stats.get(g) || { n: 0, z: 0 }; e.n++; if (v === 0) e.z++; stats.set(g, e);
      }
      let allN = 0, allZ = 0; for (const e of stats.values()) { allN += e.n; allZ += e.z; }
      if (!allN || allZ / allN >= 0.9) continue; // mostly zero everywhere, so a condition adds nothing
      for (const [g, e] of stats) {
        if (made >= 4 || e.n < 30 || e.z / e.n < 0.97) continue;
        const label = (cat.top.find(t => t.v.toLowerCase() === g) || { v: g }).v;
        add({ name: `${a.name} is 0 when ${cat.name} is ${label}`, type: 'range', columns: [a.name], params: { kind: 'number', min: 0, max: 0 }, when: { column: cat.name, values: [label] }, severity: 'medium', description: `Business rule: a record with ${cat.name} "${label}" should carry no ${a.name}.`, reason: `${pc(e.z / e.n)} of ${e.n} such rows have ${a.name} = 0 today.` });
        made++;
      }
    }
  }
  // whole-row duplicates
  if (p.nCols >= 2 && p.nCols <= 80) add({ name: 'No exact duplicate records', type: 'unique', columns: p.headers.slice(), params: { blanksMatch: true }, severity: 'high', description: 'The same record should not be loaded twice.', reason: p.dupRows ? `${p.dupRows} exact duplicate rows today.` : 'Standard load check.' });
  return out;
}

/* ---------- JSON ---------- */
const RULE_FIELDS = ['id', 'name', 'description', 'type', 'columns', 'params', 'when', 'severity', 'status', 'origin'];
function exportJSON(rules, meta) {
  return JSON.stringify({ format: 'holo-profiler-rules', version: 1, exported: new Date().toISOString(), source: meta && meta.source || null, columns: meta && meta.headers || null,
    rules: rules.map(r => { const o = {}; for (const f of RULE_FIELDS) if (r[f] !== undefined && r[f] !== null) o[f] = r[f]; return o; }) }, null, 2);
}
function importJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('This file is not valid JSON.'); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : null;
  if (!list) throw new Error('No "rules" list found in this file.');
  const out = [], skipped = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object' || !TYPES[r.type]) { skipped.push(i + 1); return; }
    const cols = Array.isArray(r.columns) ? r.columns.map(String) : typeof r.column === 'string' ? [r.column] : [];
    const params = r.params && typeof r.params === 'object' ? JSON.parse(JSON.stringify(r.params)) : {};
    if (r.type === 'allowed_values') params.values = (Array.isArray(params.values) ? params.values : typeof params.values === 'string' ? params.values.split(/\r?\n|,/) : []).filter(v => v !== null && v !== undefined).map(v => String(v).trim()).filter(Boolean);
    for (const k of ['regex', 'format', 'op', 'kind', 'flags']) if (params[k] !== undefined && typeof params[k] !== 'string') params[k] = String(params[k]);
    for (const k of ['min', 'max']) if (params[k] !== undefined && params[k] !== null && typeof params[k] !== 'number' && typeof params[k] !== 'string') delete params[k];
    const when = r.when && typeof r.when === 'object' && r.when.column ? { column: String(r.when.column), values: (Array.isArray(r.when.values) ? r.when.values : [r.when.values]).filter(v => v !== undefined && v !== null).map(String) } : undefined;
    const rule = { id: typeof r.id === 'string' && r.id.replace(/[^A-Za-z0-9_.-]/g, '') ? r.id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) : null, name: String(r.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160), description: String(r.description || '').slice(0, 600), type: r.type, columns: cols, params,
      severity: SEVERITIES.includes(r.severity) ? r.severity : 'medium', status: ['suggested', 'accepted', 'rejected'].includes(r.status) ? r.status : 'accepted', origin: r.origin === 'suggested' ? 'suggested' : 'custom' };
    if (when) rule.when = when;
    if (!rule.name) { try { rule.name = describe(rule); } catch (e) { rule.name = r.type + ' on ' + (cols.join(', ') || 'no column'); } }
    out.push(rule);
  });
  return { rules: out, skipped };
}

/* ---------- Snowflake SQL ---------- */
const sqlStr = s => "'" + String(s).replace(/'/g, "''") + "'";
// $$...$$ keeps regexes readable, but a pattern that starts or ends with $ (or holds $$) would close the quote early; those use an escaped literal.
const dollar = s => { s = String(s); return s.indexOf('$$') < 0 && !/^\$|\$$/.test(s) ? '$$' + s + '$$' : sqlStr(s.replace(/\\/g, '\\\\')); };
function sqlIdent(name) { return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : '"' + String(name).replace(/"/g, '""') + '"'; }
function sqlTable(name) { const t = String(name || '').trim() || 'MY_TABLE'; return t.split('.').map(part => /^".*"$/.test(part) ? part : sqlIdent(part)).join('.'); }
const NULL_LIST = () => Array.from(DQ.NULL_TOKENS).map(sqlStr).join(', ');
const V = c => `TRIM(${sqlIdent(c)}::VARCHAR)`;
const SQL_NULL = c => `(${sqlIdent(c)} IS NULL OR ${V(c)} = '' OR LOWER(${V(c)}) IN (${NULL_LIST()}))`;
const SQL_NUM = c => `(TRY_TO_NUMBER(REGEXP_REPLACE(${V(c)}, ${dollar('[$€£,%() ]')}, ''), 38, 6) * IFF(${V(c)} LIKE '(%)', -1, 1))`;
const SQL_DATE = c => `COALESCE(TRY_TO_DATE(${V(c)}, 'YYYY-MM-DD'), TRY_TO_DATE(${V(c)}, 'MM/DD/YYYY'), TRY_TO_DATE(${V(c)}, 'YYYY/MM/DD'), TRY_TO_DATE(${V(c)}, 'DD-MON-YYYY'), TRY_TO_DATE(${V(c)}, 'MON DD, YYYY'), TRY_TO_DATE(${V(c)}, 'YYYYMMDD'), TRY_TO_TIMESTAMP(${V(c)})::DATE)`;
function sqlFormatPass(f, c, p) {
  const v = V(c);
  switch (f) {
    case 'email': return `(REGEXP_LIKE(${v}, ${dollar("^[A-Za-z0-9._%+'-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\\.[A-Za-z]{2,}$")}) AND NOT CONTAINS(${v}, '..'))`;
    case 'phone': return `(REGEXP_LIKE(${v}, ${dollar('^(\\+?1[ .-]?)?\\(?[2-9][0-9]{2}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}( *(x|ext\\.?) *[0-9]{1,6})?$')}, 'i') OR REGEXP_LIKE(REGEXP_REPLACE(${v}, ${dollar('[ ().-]')}, ''), ${dollar('^\\+[0-9]{7,15}$')}))`;
    case 'zip': return `REGEXP_LIKE(${v}, ${dollar('^[0-9]{5}(-[0-9]{4})?$')})`;
    case 'state': return `(LENGTH(${v}) = 2 AND UPPER(${v}) IN (${Array.from(DQ.US_STATES).map(sqlStr).join(', ')}))`;
    case 'date': return `(${SQL_DATE(c)} IS NOT NULL AND YEAR(${SQL_DATE(c)}) >= 1900)`;
    case 'date_iso': return `(REGEXP_LIKE(${v}, ${dollar('^[0-9]{4}-[0-9]{2}-[0-9]{2}$')}) AND TRY_TO_DATE(${v}, 'YYYY-MM-DD') IS NOT NULL)`;
    case 'uuid': return `REGEXP_LIKE(${v}, ${dollar('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')})`;
    case 'url': return `REGEXP_LIKE(${v}, ${dollar('^https?://[^ /$.?#][^ ]*\\.[^ ]+$')}, 'i')`;
    // REGEXP_LIKE matches the whole value; REGEXP_INSTR finds the pattern anywhere, like the page does.
    case 'regex': return `(REGEXP_INSTR(${v}, ${dollar(String(p.regex).replace(/\(\?:/g, '('))}, 1, 1, 0, '${(p.flags || '').includes('i') ? 'i' : 'c'}') > 0)`;
  }
  return 'TRUE';
}
function sqlDateBound(b) { return String(b).trim().toLowerCase() === 'today' ? 'DATEADD(day, 1, CURRENT_DATE())' : `TO_DATE(${sqlStr(String(b).trim())}, 'YYYY-MM-DD')`; }
function sqlParts(rule) {
  const c = rule.columns, p = rule.params || {};
  const scope = [];
  if (rule.when) scope.push(`UPPER(${V(rule.when.column)}) IN (${rule.when.values.map(x => 'UPPER(' + sqlStr(String(x).trim()) + ')').join(', ')})`);
  let fail = null, uniqueCols = null;
  const has = x => x !== undefined && x !== null && String(x).trim() !== '';
  if (rule.type === 'not_null') fail = SQL_NULL(c[0]);
  else {
    if (!(rule.type === 'unique' && p.blanksMatch)) for (const col of c) scope.push(`NOT ${SQL_NULL(col)}`);
    if (rule.type === 'unique') uniqueCols = p.blanksMatch ? c.map(col => `COALESCE(${V(col)}, '')`) : c.map(V);
    else if (rule.type === 'format') fail = `NOT ${sqlFormatPass(p.format, c[0], p)}`;
    else if (rule.type === 'allowed_values') fail = p.caseSensitive === false ? `UPPER(${V(c[0])}) NOT IN (${p.values.map(x => 'UPPER(' + sqlStr(String(x).trim()) + ')').join(', ')})` : `${V(c[0])} NOT IN (${p.values.map(x => sqlStr(String(x).trim())).join(', ')})`;
    else if (rule.type === 'range') {
      const x = p.kind === 'date' ? SQL_DATE(c[0]) : SQL_NUM(c[0]);
      const conds = [`${x} IS NULL`];
      if (p.kind === 'date') { if (has(p.min)) conds.push(`${x} < ${sqlDateBound(p.min)}`); if (has(p.max)) conds.push(`${x} > ${sqlDateBound(p.max)}`); }
      else { if (has(p.min)) conds.push(`${x} < ${boundNum(p.min)}`); if (has(p.max)) conds.push(`${x} > ${boundNum(p.max)}`); }
      fail = '(' + conds.join(' OR ') + ')';
    } else if (rule.type === 'compare') {
      const f = p.kind === 'number' ? SQL_NUM : SQL_DATE;
      scope.push(`${f(c[0])} IS NOT NULL`, `${f(c[1])} IS NOT NULL`);
      fail = `NOT (${f(c[0])} ${p.op === '!=' ? '<>' : p.op} ${f(c[1])})`;
    }
  }
  return { scope: scope.length ? scope.join('\n    AND ') : 'TRUE', fail, uniqueCols };
}
function exportSQL(rules, opts) {
  opts = opts || {};
  const T = sqlTable(opts.table);
  const active = rules.filter(r => r.status !== 'rejected' && !checkRule(r, opts.headers).length);
  const lines = [];
  lines.push(`-- Data quality rules from Holo Profiler (Snowflake SQL)`);
  lines.push(`-- Source file: ${(opts.source || 'unknown').replace(/[\r\n]/g, ' ')}   Rules: ${active.length}   Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`-- Values are compared as trimmed text, so the queries also work on a raw all-VARCHAR landing table.`);
  lines.push(`-- Blank cells and placeholders (N/A, NULL, none...) count as missing, the same way the page counts them.`);
  lines.push('');
  if (!active.length) { lines.push('-- No active rules to export.'); return lines.join('\n'); }
  lines.push('-- 1. Summary: one row per rule with rows checked and rows failing.');
  const parts = active.map(r => {
    const s = sqlParts(r);
    const head = `SELECT ${sqlStr(r.id)} AS rule_id, ${sqlStr(r.name)} AS rule_name, ${sqlStr(r.severity.toUpperCase())} AS severity,\n       COUNT(*) AS rows_checked, `;
    const failed = s.uniqueCols ? `COUNT(*) - COUNT(DISTINCT ${s.uniqueCols.join(', ')})` : `COUNT_IF(${s.fail})`;
    return `${head}${failed} AS rows_failed\nFROM ${T}\nWHERE ${s.scope}`;
  });
  lines.push(parts.join('\nUNION ALL\n') + '\nORDER BY rule_id;');
  lines.push('');
  lines.push('-- 2. Failing rows for each rule (run the one you need).');
  for (const r of active) {
    const s = sqlParts(r);
    lines.push('');
    lines.push(`-- ${r.id} [${r.severity.toUpperCase()}] ${r.name.replace(/[\r\n]/g, ' ')}`);
    lines.push(`--   ${describe(r).replace(/[\r\n]/g, ' ')}`);
    if (s.uniqueCols) lines.push(`SELECT * FROM ${T}\nWHERE ${s.scope}\nQUALIFY ROW_NUMBER() OVER (PARTITION BY ${s.uniqueCols.join(', ')} ORDER BY ${s.uniqueCols[0]}) > 1;`);
    else lines.push(`SELECT * FROM ${T}\nWHERE ${s.scope}\n  AND ${s.fail};`);
  }
  return lines.join('\n') + '\n';
}


const api = { SEVERITIES, SEV_WEIGHT, RULES_SCORE, TYPES, FORMATS, OPS, OP_WORDS, isNull, checkRule, describe, ruleKey, runRule, runRules, scoreRules, suggestRules, shapeRegex, exportJSON, importJSON, exportSQL, sqlParts, sqlTable };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
