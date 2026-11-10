/* DQ profiling engine: pure functions, no DOM. Works in the browser and in Node. */
(function (root) {
'use strict';

const WEIGHTS = { completeness: 0.35, validity: 0.30, uniqueness: 0.20, consistency: 0.15 };
// File score = half the weighted dimension score, half the clean-record rate,
// minus a fixed penalty for each critical issue (capped). Bands are for the file and rules scores.
const SCORE = { dimShare: 0.5, cleanShare: 0.5, critEach: 0.04, critMax: 0.20, good: 0.90, fair: 0.75 };
const MAX_ROWS = 200000;          // rows profiled before sampling kicks in
const INFER_SAMPLE = 5000;        // values used to infer a column's type
const NULL_TOKENS = new Set(['null', 'nil', 'none', 'n/a', 'na', 'nan', '#n/a', 'undefined', '-', '--', '?', '(null)', '(blank)']);
const BOOL_TOKENS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 't', 'f']);
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU AS MP'.split(' '));
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const RE = {
  email: /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/,
  phoneUS: /^(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?:\s*(?:x|ext\.?)\s*\d{1,6})?$/i,
  phoneIntl: /^\+\d{7,15}$/,
  zip: /^\d{5}(?:-\d{4})?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  url: /^https?:\/\/[^\s/$.?#][^\s]*\.[^\s]+$/i,
  num: /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$|^[+-]?\.\d+$/,
  isoDate: /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/,
  ymdSlash: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  mdy: /^(\d{1,2})([\/.-])(\d{1,2})\2(\d{4}|\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  dMonY: /^(\d{1,2})[\s-]([A-Za-z]{3,9})\.?[\s-],?\s*(\d{4}|\d{2})$/,
  monDY: /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/,
  compact: /^(\d{4})(\d{2})(\d{2})$/,
  control: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/
};

/* ---------- value parsers ---------- */
function parseNum(raw) {
  let t = raw.trim(), neg = false, formatted = false;
  if (t.length > 2 && t[0] === '(' && t[t.length - 1] === ')') { neg = true; formatted = true; t = t.slice(1, -1).trim(); }
  if (/[$€£]/.test(t)) { formatted = true; t = t.replace(/^([+-]?)\s*[$€£]\s*([+-]?)/, (m, a, b) => a || b); }
  if (t.endsWith('%')) { formatted = true; t = t.slice(0, -1).trim(); }
  if (!RE.num.test(t)) return null;
  if (t.indexOf(',') >= 0) formatted = true;
  const v = Number(t.replace(/,/g, ''));
  if (!isFinite(v)) return null;
  return { v: neg ? -v : v, int: !/[.eE]/.test(t), formatted, lead0: /^[+-]?0\d/.test(t) };
}

function mkDate(y, m, d, hh, mm, ss) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}
function yr2(y) { return y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y; }

function parseDate(raw, allowCompact) {
  const s = raw.trim();
  let m, t;
  if ((m = RE.isoDate.exec(s))) {
    t = mkDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    return t === null ? null : { t, fmt: m[4] ? 'YYYY-MM-DD hh:mm' : 'YYYY-MM-DD', time: !!m[4] };
  }
  if ((m = RE.ymdSlash.exec(s))) { t = mkDate(+m[1], +m[2], +m[3]); return t === null ? null : { t, fmt: 'YYYY/MM/DD' }; }
  if ((m = RE.mdy.exec(s))) {
    let a = +m[1], b = +m[3], y = yr2(+m[4]), sep = m[2], hh = m[5] ? +m[5] : 0;
    if (m[8]) { const pm = /p/i.test(m[8]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
    const yf = m[4].length === 4 ? 'YYYY' : 'YY';
    if (a > 12 && b <= 12) { t = mkDate(y, b, a, hh, m[6] ? +m[6] : 0); return t === null ? null : { t, fmt: 'DD' + sep + 'MM' + sep + yf, time: !!m[5] }; }
    t = mkDate(y, a, b, hh, m[6] ? +m[6] : 0);
    return t === null ? null : { t, fmt: 'MM' + sep + 'DD' + sep + yf + (m[5] ? ' hh:mm' : ''), time: !!m[5] };
  }
  if ((m = RE.dMonY.exec(s))) { const mo = MONTHS[m[2].toLowerCase()]; if (!mo) return null; t = mkDate(yr2(+m[3]), mo, +m[1]); return t === null ? null : { t, fmt: 'DD-Mon-YYYY' }; }
  if ((m = RE.monDY.exec(s))) { const mo = MONTHS[m[1].toLowerCase()]; if (!mo) return null; t = mkDate(+m[3], mo, +m[2]); return t === null ? null : { t, fmt: 'Mon DD, YYYY' }; }
  if (allowCompact && (m = RE.compact.exec(s))) { const y = +m[1]; if (y < 1900 || y > 2100) return null; t = mkDate(y, +m[2], +m[3]); return t === null ? null : { t, fmt: 'YYYYMMDD' }; }
  return null;
}

const isEmail = s => RE.email.test(s) && s.indexOf('..') < 0;
const isPhone = s => RE.phoneUS.test(s) || RE.phoneIntl.test(s.replace(/[\s().-]/g, ''));
const isZip = s => RE.zip.test(s);
const isUuid = s => RE.uuid.test(s);
const isUrl = s => RE.url.test(s);
const isState = s => US_STATES.has(s.toUpperCase());
const isBool = s => BOOL_TOKENS.has(s.toLowerCase());
const phoneFmt = s => /^\(\d{3}\) \d{3}-\d{4}$/.test(s) ? '(999) 999-9999' : /^\d{3}-\d{3}-\d{4}$/.test(s) ? '999-999-9999'
  : /^\d{3}\.\d{3}\.\d{4}$/.test(s) ? '999.999.9999' : /^\d{10}$/.test(s) ? '9999999999' : /^\+/.test(s) ? '+international' : 'other';

function shapeOf(s) {
  if (s.length > 40) return 'long text';
  return s.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9');
}

/* ---------- name hints ---------- */
function nameHints(name) {
  const n = String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const tok = n.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...w) => w.some(x => tok.includes(x));
  return {
    email: /e-?mail/.test(n),
    phone: /phone|mobile|cell|telephone|fax/.test(n) || has('tel', 'ph'),
    zip: /zip|postal|postcode/.test(n),
    date: /date|timestamp|time/.test(n) || has('dt', 'dob', 'day', 'at', 'on') || /birth/.test(n),
    state: has('state', 'st', 'province') || /state_?(cd|code)/.test(n),
    amount: /amount|amt|paid|reserve|premium|price|cost|total|balance|payment|incurred|salary|fee|revenue|limit|deductible|value/.test(n),
    id: has('id', 'key', 'uuid', 'guid', 'number', 'num', 'no', 'nbr', 'code', 'ref', 'identifier'),
    pastEvent: /loss|report|incident|birth|dob|created|occur|paid|closed|received|notice|accident|injury|submitted|opened/.test(n)
  };
}

/* ---------- type inference ---------- */
function rate(vals, fn) { if (!vals.length) return 0; let c = 0; for (const v of vals) if (fn(v)) c++; return c / vals.length; }

function inferType(name, sample) {
  const h = nameHints(name);
  const r = {
    email: rate(sample, isEmail), phone: rate(sample, isPhone), zip: rate(sample, isZip), state: rate(sample, isState),
    uuid: rate(sample, isUuid), url: rate(sample, isUrl), bool: rate(sample, isBool),
    date: rate(sample, s => parseDate(s, h.date) !== null)
  };
  let nNum = 0, nInt = 0, nLead0 = 0;
  for (const s of sample) { const p = parseNum(s); if (p) { nNum++; if (p.int) nInt++; if (p.lead0) nLead0++; } }
  r.num = sample.length ? nNum / sample.length : 0;
  const allInt = nNum > 0 && nInt === nNum;
  const lead0 = nNum ? nLead0 / nNum : 0;
  let type;
  if (h.email && r.email >= 0.5) type = 'email';
  else if (h.phone && r.phone >= 0.5) type = 'phone';
  else if (h.zip && r.zip >= 0.5) type = 'zip';
  else if (h.state && r.state >= 0.5) type = 'state';
  else if (h.date && r.date >= 0.5) type = 'date';
  else if (r.uuid >= 0.8) type = 'uuid';
  else if (r.email >= 0.8) type = 'email';
  else if (r.url >= 0.8) type = 'url';
  else if (r.date >= 0.8 && r.num < 0.5) type = 'date';
  else if (r.bool >= 0.95) type = 'boolean';
  else if (r.num >= 0.8) {
    if (lead0 > 0.05 || (h.id && allInt && !h.amount)) type = 'identifier';
    else type = allInt ? 'integer' : 'decimal';
  }
  else if (r.phone >= 0.9) type = 'phone';
  else if (r.zip >= 0.9) type = 'zip';
  else type = h.id ? 'identifier' : 'text';
  return { type, rates: r, hints: h };
}

const TYPE_META = {
  email:      { base: 'text',    label: 'Email',      rule: 'valid email address', test: isEmail },
  phone:      { base: 'text',    label: 'Phone',      rule: 'valid phone number', test: isPhone },
  zip:        { base: 'text',    label: 'ZIP code',   rule: '5-digit or ZIP+4 format', test: isZip },
  state:      { base: 'text',    label: 'US state',   rule: 'valid 2-letter US state code', test: s => /^[A-Za-z]{2}$/.test(s) && isState(s) },
  uuid:       { base: 'text',    label: 'UUID',       rule: 'UUID format', test: isUuid },
  url:        { base: 'text',    label: 'URL',        rule: 'http(s) URL', test: isUrl },
  date:       { base: 'date',    label: 'Date',       rule: 'parseable calendar date' },
  boolean:    { base: 'boolean', label: 'Boolean',    rule: 'true/false style value', test: isBool },
  integer:    { base: 'number',  label: 'Integer',    rule: 'numeric value' },
  decimal:    { base: 'number',  label: 'Decimal',    rule: 'numeric value' },
  identifier: { base: 'text',    label: 'Identifier', rule: null, test: () => true },
  text:       { base: 'text',    label: 'Text',       rule: null, test: () => true }
};

/* ---------- stats helpers ---------- */
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function histogram(sorted, lo, hi, nb) {
  const bins = new Array(nb).fill(0); let below = 0, above = 0;
  const w = (hi - lo) / nb;
  for (const v of sorted) {
    if (v < lo) { below++; continue; }
    if (v > hi) { above++; continue; }
    let i = w > 0 ? Math.floor((v - lo) / w) : 0; if (i >= nb) i = nb - 1; bins[i]++;
  }
  return { lo, hi, bins, below, above };
}
const pct = (a, b) => (b ? a / b : 0);
const nw = (k, one, many) => k.toLocaleString('en-US') + ' ' + (k === 1 ? one : (many || one + 's'));

/* ---------- column profile ---------- */
function profileColumn(name, idx, rows, nRows, now, flags) {
  const present = [], presentRow = [];
  let missing = 0, blank = 0, placeholder = 0, whitespace = 0, control = 0;
  const phTokens = new Map();
  for (let r = 0; r < nRows; r++) {
    const raw = rows[r][idx];
    if (raw === undefined || raw === null || raw === '') { missing++; if (flags) flags[r] |= 1; continue; }
    const s = String(raw);
    const t = s.trim();
    if (t === '') { blank++; if (flags) flags[r] |= 1; continue; }
    if (NULL_TOKENS.has(t.toLowerCase())) { placeholder++; if (flags) flags[r] |= 1; phTokens.set(t, (phTokens.get(t) || 0) + 1); continue; }
    if (t !== s) whitespace++;
    if (RE.control.test(t)) control++;
    present.push(t); presentRow.push(r);
  }
  const nPresent = present.length;
  const step = Math.max(1, Math.floor(nPresent / INFER_SAMPLE));
  const sample = []; for (let i = 0; i < nPresent && sample.length < INFER_SAMPLE; i += step) sample.push(present[i]);
  const inf = inferType(name, sample);
  const type = inf.type, meta = TYPE_META[type], h = inf.hints;

  // distinct + top values
  const counts = new Map();
  for (const v of present) counts.set(v, (counts.get(v) || 0) + 1);
  const distinct = counts.size;
  const sortedCounts = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top = sortedCounts.slice(0, 12).map(([v, c]) => ({ v, c }));
  const categorical = nPresent >= 20 && (distinct <= 30 || distinct / nPresent <= 0.02) && type !== 'date' && meta.base !== 'number';

  // validity
  let valid = 0; const invalid = []; const nums = []; const times = [];
  const fmtCounts = new Map(); let negatives = 0; const negSamples = []; let future = 0; const futureSamples = []; let ancient = 0;
  const nowT = now;
  for (let i = 0; i < nPresent; i++) {
    const s = present[i]; let ok;
    if (meta.base === 'number') {
      const p = parseNum(s);
      ok = !!p;
      if (p) {
        fmtCounts.set(p.formatted ? 'formatted (1,234.00 / $)' : 'plain', (fmtCounts.get(p.formatted ? 'formatted (1,234.00 / $)' : 'plain') || 0) + 1);
        nums.push(p.v);
        if (h.amount && p.v < 0) { negatives++; ok = false; if (negSamples.length < 6) negSamples.push({ v: s, row: presentRow[i] }); }
      }
    } else if (type === 'date') {
      const d = parseDate(s, h.date);
      ok = !!d;
      if (d) {
        fmtCounts.set(d.fmt, (fmtCounts.get(d.fmt) || 0) + 1);
        const y = new Date(d.t).getUTCFullYear();
        if (y < 1900) { ancient++; ok = false; }
        else if (h.pastEvent && d.t > nowT + 86400000) { future++; ok = false; if (futureSamples.length < 6) futureSamples.push({ v: s, row: presentRow[i] }); }
        times.push(d.t);
      }
    } else if (type === 'phone') {
      ok = isPhone(s); const f = phoneFmt(s); if (ok) fmtCounts.set(f, (fmtCounts.get(f) || 0) + 1);
    } else {
      ok = meta.test(s);
    }
    if (ok && RE.control.test(s)) ok = false;
    if (ok) { valid++; continue; }
    if (flags) flags[presentRow[i]] |= 2;
    if (invalid.length < 8 && !(h.amount && meta.base === 'number' && parseNum(s)) && !(type === 'date' && parseDate(s, h.date))) invalid.push({ v: s, row: presentRow[i] });
  }
  const nInvalidFormat = nPresent - valid - negatives - future - ancient;

  // numeric stats
  let num = null;
  if (meta.base === 'number' && nums.length) {
    const sorted = Float64Array.from(nums).sort();
    const n = sorted.length; let sum = 0; for (const v of sorted) sum += v;
    const mean = sum / n; let ss = 0; for (const v of sorted) ss += (v - mean) * (v - mean);
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1, median = quantile(sorted, 0.5);
    const std = Math.sqrt(ss / Math.max(1, n - 1));
    // Right-skewed non-negative data (claim amounts, premiums) gets its fences on a log scale,
    // so the natural long tail is not reported as outliers.
    const posVals = []; for (const v of sorted) if (v > 0) posVals.push(v);
    const pq1 = quantile(posVals, 0.25), pq3 = quantile(posVals, 0.75), pmed = quantile(posVals, 0.5);
    const bowley = pq3 > pq1 ? (pq3 + pq1 - 2 * pmed) / (pq3 - pq1) : 0; // robust skewness, not moved by the outliers themselves
    const nonNeg = sorted.filter(v => v >= 0).length / n;
    const skewed = posVals.length >= 20 && nonNeg >= 0.95 && bowley > 0.2;
    let lo = -Infinity, hi = Infinity;
    if (skewed) {
      // fences on log(positive values); zeros and negatives are judged separately
      const lg = posVals.map(Math.log); const lq1 = quantile(lg, 0.25), lq3 = quantile(lg, 0.75), liqr = lq3 - lq1;
      if (liqr > 0) { lo = Math.exp(lq1 - 3 * liqr); hi = Math.exp(lq3 + 3 * liqr); }
    } else if (iqr > 0) { lo = q1 - 3 * iqr; hi = q3 + 3 * iqr; }
    let outLow = 0, outHigh = 0; const outSamples = [];
    for (let i = 0; i < nPresent; i++) {
      const p = parseNum(present[i]); if (!p) continue;
      if (skewed && p.v <= 0) continue;
      if (p.v < lo) outLow++; else if (p.v > hi) outHigh++; else continue;
      outSamples.push({ v: present[i], row: presentRow[i], n: p.v });
    }
    outSamples.sort((a, b) => Math.abs(b.n) - Math.abs(a.n)); outSamples.length = Math.min(outSamples.length, 8);
    const p99 = quantile(sorted, 0.99);
    const hLo = isFinite(lo) && !skewed ? Math.max(sorted[0], lo) : sorted[0];
    const hHi = skewed ? Math.min(sorted[n - 1], p99) : (isFinite(hi) ? Math.min(sorted[n - 1], hi) : sorted[n - 1]);
    num = { min: sorted[0], max: sorted[n - 1], mean, median, std, q1, q3, sum, skewed, outlierMethod: skewed ? '3×IQR, log scale for skewed data' : '3×IQR',
      fenceLo: lo, fenceHi: hi, outLow, outHigh, outSamples, negatives, zeros: nums.filter(v => v === 0).length,
      hist: histogram(sorted, hLo, hHi === hLo ? hLo + 1 : hHi, 28) };
  }
  let date = null;
  if (type === 'date' && times.length) {
    const sorted = Float64Array.from(times).sort();
    const plaus = sorted.filter(t => new Date(t).getUTCFullYear() >= 1900 && t <= nowT + 366 * 86400000);
    const base = plaus.length ? plaus : sorted;
    date = { min: sorted[0], max: sorted[sorted.length - 1], future, ancient, futureSamples, hist: histogram(base, base[0], base[base.length - 1] === base[0] ? base[0] + 86400000 : base[base.length - 1], 28) };
  }
  let lens = null;
  if (meta.base === 'text' && nPresent) {
    let mn = Infinity, mx = 0, tot = 0; for (const s of present) { const L = s.length; if (L < mn) mn = L; if (L > mx) mx = L; tot += L; }
    lens = { min: mn, max: mx, avg: tot / nPresent };
  }

  // shapes (structured identifiers)
  const shapes = new Map();
  if (meta.base === 'text') for (let i = 0; i < nPresent; i += Math.max(1, Math.floor(nPresent / 20000))) { const sh = shapeOf(present[i]); shapes.set(sh, (shapes.get(sh) || 0) + 1); }
  const shapeTotal = Array.from(shapes.values()).reduce((a, b) => a + b, 0);
  const topShapes = Array.from(shapes.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => ({ s, c, share: pct(c, shapeTotal) }));

  // case / spacing variants for categorical values
  const variants = [];
  if (categorical || type === 'state' || (meta.base === 'text' && distinct <= 200 && nPresent >= 20)) {
    const groups = new Map();
    for (const [v, c] of counts) { const k = v.toLowerCase().replace(/\s+/g, ' '); if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ v, c }); }
    for (const [k, forms] of groups) if (forms.length > 1) { forms.sort((a, b) => b.c - a.c); variants.push({ key: k, forms, minority: forms.slice(1).reduce((a, f) => a + f.c, 0) }); }
    variants.sort((a, b) => b.minority - a.minority);
  }
  const variantRows = variants.reduce((a, g) => a + g.minority, 0);

  // formats
  const fmtList = Array.from(fmtCounts.entries()).sort((a, b) => b[1] - a[1]).map(([f, c]) => ({ f, c }));
  const fmtTotal = fmtList.reduce((a, b) => a + b.c, 0);

  // key detection
  const nonNull = nPresent;
  const distinctRatio = pct(distinct, nonNull);
  let key = null;
  const keyEligible = type === 'identifier' || type === 'uuid' || (h.id && !h.amount && meta.base !== 'date');
  if (nonNull >= 10 && keyEligible && !categorical) {
    if (distinct === nonNull && nonNull === nRows) key = 'candidate';
    else if ((type === 'uuid' || type === 'identifier' || h.id) && distinctRatio >= 0.9 && !(h.amount)) key = distinct === nonNull ? 'unique-incomplete' : 'duplicates';
  }
  let dupValues = 0; const dupSamples = [];
  if (key) for (const [v, c] of sortedCounts) { if (c < 2) break; dupValues += c - 1; if (dupSamples.length < 8) dupSamples.push({ v, c }); }

  // dimension scores
  const nullish = missing + blank + placeholder;
  const completeness = nRows ? 1 - nullish / nRows : 1;
  const validity = nPresent ? valid / nPresent : null;
  const uniqueness = key ? (nonNull ? distinct / nonNull : 1) : null;
  let base = 1, consistencyNote = '';
  if (fmtTotal && fmtList.length > 1) { base = fmtList[0].c / fmtTotal; consistencyNote = 'share using the dominant format'; }
  else if (variantRows) { base = 1 - variantRows / nPresent; consistencyNote = 'share without case or spacing variants'; }
  else if (type === 'identifier' && topShapes.length && topShapes[0].share >= 0.5 && /[A-Za-z]/.test(topShapes[0].s)) { base = topShapes[0].share; consistencyNote = 'share matching the dominant pattern'; }
  if (fmtList.length > 1 && variantRows) base = Math.min(base, 1 - variantRows / nPresent);
  const wsRate = pct(whitespace, nPresent);
  const consistency = nPresent ? Math.max(0, base * (1 - wsRate)) : null;
  const dims = { completeness, validity, uniqueness, consistency };
  const score = weightedScore(dims);

  // issues
  const issues = [];
  const pc = v => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
  const add = (sev, dim, text, count, extra) => issues.push(Object.assign({ sev, dim, col: name, colIdx: idx, text, count }, extra || {}));
  const nullRate = pct(nullish, nRows);
  if (nRows && nPresent === 0) add('critical', 'completeness', 'Column is completely empty', nRows);
  else if (nullRate > 0.95) add('critical', 'completeness', `${pc(nullRate)} of values are missing`, nullish);
  else if (nullRate > 0.2) add('critical', 'completeness', `${pc(nullRate)} of values are missing`, nullish);
  else if (nullRate > 0.05) add('warning', 'completeness', `${pc(nullRate)} of values are missing`, nullish);
  else if (nullish > 0) add('info', 'completeness', `${nw(nullish, 'missing value')} (${pc(nullRate)})`, nullish);
  if (placeholder) add('warning', 'completeness', `Placeholder text used as a value: ${Array.from(phTokens.keys()).slice(0, 4).map(t => '"' + t + '"').join(', ')}`, placeholder);
  if (key === 'duplicates' && dupValues) add('critical', 'uniqueness', `${nw(dupValues, 'duplicate value')} in a likely key column`, dupValues, { samples: dupSamples.map(d => ({ v: d.v + ' ×' + d.c })) });
  if (meta.rule && nInvalidFormat > 0) {
    const r2 = pct(nInvalidFormat, nPresent);
    add(r2 > 0.05 ? 'critical' : 'warning', 'validity', `${nw(nInvalidFormat, 'value fails', 'values fail')} the ${meta.rule} check (${pc(r2)})`, nInvalidFormat, { samples: invalid });
  }
  if (negatives) add('warning', 'validity', `${nw(negatives, 'negative amount')}`, negatives, { samples: negSamples });
  if (future) add('warning', 'validity', `${nw(future, 'date is', 'dates are')} in the future`, future, { samples: futureSamples });
  if (ancient) add('warning', 'validity', `${nw(ancient, 'date')} before 1900`, ancient);
  if (num && (num.outLow + num.outHigh)) add('warning', 'validity', `${nw(num.outLow + num.outHigh, 'extreme outlier')} (${num.outlierMethod})`, num.outLow + num.outHigh, { samples: num.outSamples });
  if (fmtList.length > 1) add('warning', 'consistency', `${fmtList.length} formats in use; ${(fmtTotal - fmtList[0].c).toLocaleString()} values differ from "${fmtList[0].f}"`, fmtTotal - fmtList[0].c);
  if (variants.length) add('warning', 'consistency', `${variants.length} value${variants.length > 1 ? 's' : ''} spelled with different case or spacing, e.g. ${variants[0].forms.slice(0, 3).map(f => '"' + f.v + '"').join(' / ')}`, variantRows);
  if (whitespace) add('info', 'consistency', `${nw(whitespace, 'value has', 'values have')} leading or trailing spaces`, whitespace);
  if (control) add('warning', 'validity', `${nw(control, 'value contains', 'values contain')} control or replacement characters`, control);
  if (nPresent >= 10 && distinct === 1) add('info', 'consistency', `Only one distinct value ("${top[0].v.slice(0, 30)}")`, nPresent);

  return {
    name, idx, type, typeLabel: meta.label, base: meta.base, rule: meta.rule, hints: h, rates: inf.rates,
    n: nRows, present: nPresent, missing, blank, placeholder, placeholderTokens: Array.from(phTokens.entries()).map(([t, c]) => ({ t, c })),
    whitespace, control, distinct, distinctRatio, categorical, top, valid, invalidCount: nPresent - valid, invalidSamples: invalid,
    num, date, lens, formats: fmtList, topShapes, variants: variants.slice(0, 10), key, dupValues, dupSamples,
    dims, score, consistencyNote, issues
  };
}

function weightedScore(d) {
  let s = 0, w = 0;
  for (const k of Object.keys(WEIGHTS)) if (d[k] !== null && d[k] !== undefined && !isNaN(d[k])) { s += WEIGHTS[k] * d[k]; w += WEIGHTS[k]; }
  return w ? s / w : null;
}

/* ---------- cross-field rules: date ordering ---------- */
function dateOrderRules(cols, rows, nRows) {
  const dcols = cols.filter(c => c.type === 'date' && c.present >= Math.max(5, nRows * 0.5)).slice(0, 10);
  if (dcols.length < 2) return [];
  const parsed = dcols.map(c => { const a = new Float64Array(nRows).fill(NaN); for (let r = 0; r < nRows; r++) { const raw = rows[r][c.idx]; if (raw === undefined || raw === null || raw === '') continue; const d = parseDate(String(raw), c.hints.date); if (d) a[r] = d.t; } return a; });
  const rules = [];
  for (let i = 0; i < dcols.length; i++) for (let j = i + 1; j < dcols.length; j++) {
    let le = 0, gt = 0, both = 0; const A = parsed[i], B = parsed[j];
    for (let r = 0; r < nRows; r++) { if (isNaN(A[r]) || isNaN(B[r])) continue; both++; if (A[r] <= B[r]) le++; else gt++; }
    if (both < 10) continue;
    let first, second, bad, F, S;
    if (le / both >= 0.9 && gt > 0) { first = dcols[i]; second = dcols[j]; bad = gt; F = A; S = B; }
    else if (gt / both >= 0.9 && le > 0) {
      let lt = 0; for (let r = 0; r < nRows; r++) if (!isNaN(A[r]) && !isNaN(B[r]) && B[r] > A[r]) lt++;
      if (!lt) continue; first = dcols[j]; second = dcols[i]; bad = lt; F = B; S = A;
    } else continue;
    const samples = []; const badRows = new Set();
    for (let r = 0; r < nRows; r++) if (!isNaN(F[r]) && !isNaN(S[r]) && F[r] > S[r]) { badRows.add(r); if (samples.length < 8) samples.push({ row: r, v: `${second.name} ${rows[r][second.idx]} < ${first.name} ${rows[r][first.idx]}` }); }
    rules.push({ first: first.name, second: second.name, checked: both, violations: bad, rate: bad / both, samples, badRows,
      text: `${second.name} is earlier than ${first.name}` });
  }
  return rules;
}

/* ---------- table profile ---------- */
function cleanHeaders(raw) {
  const seen = new Map();
  return raw.map((h, i) => {
    let n = (h === undefined || h === null ? '' : String(h)).replace(/^﻿/, '').trim();
    if (!n) n = 'column_' + (i + 1);
    const k = n.toLowerCase();
    if (seen.has(k)) { const c = seen.get(k) + 1; seen.set(k, c); n = n + ' (' + c + ')'; } else seen.set(k, 1);
    return n;
  });
}

function profileTable(input) {
  const t0 = Date.now();
  const now = input.now || Date.now();
  const headers = cleanHeaders(input.headers || []);
  const rows = input.rows || [];
  const nRows = rows.length, nCols = headers.length;
  let ragged = 0; for (const r of rows) if (r.length !== nCols) ragged++;
  const flags = new Uint8Array(nRows);
  const cols = headers.map((h, i) => profileColumn(h, i, rows, nRows, now, flags));

  // duplicate rows
  const seen = new Map(); let dupRows = 0; const dupRowSamples = [];
  for (let r = 0; r < nRows; r++) {
    const k = rows[r].map(v => (v === undefined || v === null ? '' : String(v).trim())).join('\u0001');
    if (seen.has(k)) { dupRows++; flags[r] |= 8; if (dupRowSamples.length < 8) dupRowSamples.push({ row: r, v: 'same as row ' + (seen.get(k) + 1) }); } else seen.set(k, r);
  }
  const rules = dateOrderRules(cols, rows, nRows);
  const ruleBadRows = new Set(); for (const rl of rules) for (const r of rl.badRows) { ruleBadRows.add(r); flags[r] |= 16; }
  for (const c of cols) if (c.key === 'duplicates') { const firstSeen = new Set(); for (let r = 0; r < nRows; r++) { const v = rows[r][c.idx]; if (v === undefined || v === null || v === '') continue; const k = String(v).trim(); if (firstSeen.has(k)) flags[r] |= 8; else firstSeen.add(k); } }
  let cleanRows = 0, rowsMissing = 0, rowsInvalid = 0; for (let r = 0; r < nRows; r++) { if (!flags[r]) cleanRows++; if (flags[r] & 1) rowsMissing++; if (flags[r] & 2) rowsInvalid++; }

  // file-level dimensions
  const totalCells = nRows * nCols;
  let nullCells = 0, validW = 0, presentTot = 0, consW = 0;
  for (const c of cols) { nullCells += c.n - c.present; if (c.dims.validity !== null) { validW += c.dims.validity * c.present; presentTot += c.present; consW += (c.dims.consistency || 0) * c.present; } }
  const keyCols = cols.filter(c => c.key);
  const keyUniq = keyCols.length ? keyCols.reduce((a, c) => a + c.dims.uniqueness, 0) / keyCols.length : 1;
  const dims = {
    completeness: totalCells ? 1 - nullCells / totalCells : null,
    validity: presentTot ? validW / presentTot : null,
    uniqueness: nRows ? (1 - dupRows / nRows) * keyUniq : null,
    consistency: presentTot ? (consW / presentTot) * (nRows ? 1 - ruleBadRows.size / nRows : 1) : null
  };
  const dimScore = weightedScore(dims);

  const issues = [];
  for (const c of cols) issues.push(...c.issues);
  if (dupRows) issues.push({ sev: dupRows / nRows > 0.01 ? 'critical' : 'warning', dim: 'uniqueness', col: null, text: `${nw(dupRows, 'exact duplicate row')}`, count: dupRows, samples: dupRowSamples });
  for (const rl of rules) issues.push({ sev: rl.rate > 0.01 ? 'critical' : 'warning', dim: 'consistency', col: null, text: `${rl.text} in ${nw(rl.violations, 'row')}`, count: rl.violations, samples: rl.samples, rule: true });
  if (ragged) issues.push({ sev: 'warning', dim: 'validity', col: null, text: `${nw(ragged, 'row has', 'rows have')} a different number of fields than the header`, count: ragged });
  if (nCols && !cols.some(c => c.key === 'candidate') && nRows >= 10) issues.push({ sev: 'info', dim: 'uniqueness', col: null, text: 'No column is complete and unique, so no clean primary key was found', count: 0 });
  if (input.sampled) issues.push({ sev: 'info', dim: null, col: null, text: `Profiled a random sample of ${nRows.toLocaleString()} of ${input.totalRows.toLocaleString()} rows`, count: 0 });
  const sevRank = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => sevRank[a.sev] - sevRank[b.sev] || b.count - a.count);
  for (const rl of rules) delete rl.badRows;

  const cleanRate = nRows ? cleanRows / nRows : null;
  const nCritical = issues.filter(i => i.sev === 'critical').length;
  const critPenalty = Math.min(SCORE.critMax, nCritical * SCORE.critEach);
  const blended = dimScore === null ? null : cleanRate === null ? dimScore : SCORE.dimShare * dimScore + SCORE.cleanShare * cleanRate;
  const score = blended === null ? null : Math.max(0, blended - critPenalty);
  const scoreParts = { dimScore, cleanRate, blended, nCritical, critPenalty };

  return { headers, nRows, nCols, totalRows: input.totalRows || nRows, sampled: !!input.sampled, ragged, cols, dupRows, dupRowSamples, rules,
    cleanRows, rowsMissing, rowsInvalid, dims, score, scoreParts, issues, keyCandidates: cols.filter(c => c.key === 'candidate').map(c => c.name), ms: Date.now() - t0, weights: WEIGHTS, scoring: SCORE };
}

/* ---------- column groups for wide files ----------
   Above GROUP_AT columns the ring shows arcs of related columns instead of one spoke each.
   Columns fall into families by what they hold, then big families split into parts, cut at
   shared name prefixes where possible, so the ring ends up with roughly 12 to 16 arcs. */
const GROUP_AT = 24;
const FAMILIES = [
  ['ids', 'IDs and keys', 'IDS'], ['dates', 'Dates', 'DATES'], ['amounts', 'Amounts', 'AMOUNTS'], ['measures', 'Counts and measures', 'MEASURES'],
  ['codes', 'Codes and categories', 'CODES'], ['flags', 'Flags', 'FLAGS'], ['contact', 'Contact', 'CONTACT'], ['location', 'Location', 'PLACE'], ['text', 'Free text', 'TEXT']
];
function columnFamily(c) {
  const n = String(c.name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const tok = n.split(/[^a-z0-9]+/).filter(Boolean);
  const h = c.hints || {};
  if (c.type === 'email' || c.type === 'phone' || c.type === 'url') return 'contact';
  if (c.type === 'boolean') return 'flags';
  if (c.type === 'date') return 'dates';
  if (c.type === 'zip' || c.type === 'state' || /addr|address|city|county|country|postal|latitude|longitude/.test(n) || tok.some(t => t === 'lat' || t === 'lon' || t === 'lng' || t === 'geo')) return 'location';
  if (c.key || c.type === 'uuid' || (c.type === 'identifier' && !c.categorical)) return 'ids';
  if (c.base === 'number') return h.amount ? 'amounts' : 'measures';
  if (/^(is|has|flag)$/.test(tok[0] || '') || tok.includes('flag') || tok.includes('ind')) return 'flags';
  if (c.categorical || c.type === 'identifier') return 'codes';
  return 'text';
}
function namePrefix(name) {
  const t = String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return t.length > 1 ? t[0] : '';
}
function columnGroups(cols, opts) {
  opts = opts || {};
  const n = cols.length, at = opts.groupAt === undefined ? GROUP_AT : opts.groupAt;
  if (n <= at) return { grouped: false, groups: [], order: cols.map((c, i) => i), groupOf: cols.map(() => -1) };
  const fam = new Map(FAMILIES.map(f => [f[0], []]));
  cols.forEach((c, i) => fam.get(columnFamily(c)).push(i));
  const live = FAMILIES.filter(f => fam.get(f[0]).length);
  const maxGroups = opts.maxGroups || 16;
  const T = Math.max(live.length, Math.min(maxGroups, Math.ceil(n / 18)));
  // share the arcs between families by size, at least one each (largest remainder)
  const budget = live.map(() => 1), rest = T - live.length;
  if (rest > 0) {
    const pos = live.map(f => Math.max(0, fam.get(f[0]).length / n * T - 1)), tot = pos.reduce((a, b) => a + b, 0) || 1;
    const raw = pos.map(s => s / tot * rest), base = raw.map(Math.floor);
    let left = rest - base.reduce((a, b) => a + b, 0);
    const order = raw.map((r, k) => [r - base[k], k]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k][1]]++;
    base.forEach((b, k) => { budget[k] += b; });
  }
  const groups = [];
  live.forEach(([key, label, short], k) => {
    let idx = fam.get(key);
    const parts = Math.min(budget[k], idx.length);
    if (parts <= 1) { groups.push({ key, family: key, label, short, familyShort: short, cols: idx.slice() }); return; }
    // order by name prefix (first seen first), then position, so related columns sit together
    const first = new Map(); idx.forEach(i => { const p = namePrefix(cols[i].name); if (!first.has(p)) first.set(p, first.size); });
    idx = idx.slice().sort((a, b) => (first.get(namePrefix(cols[a].name)) - first.get(namePrefix(cols[b].name))) || a - b);
    const m = idx.length, size = m / parts, cuts = [0];
    for (let q = 1; q < parts; q++) {
      const prev = cuts[cuts.length - 1], ideal = Math.round(q * size), slack = Math.max(1, Math.floor(size * 0.4));
      let best = ideal, bd = Infinity;
      for (let x = Math.max(prev + 1, ideal - slack); x <= Math.min(m - (parts - q), ideal + slack); x++) {
        if (namePrefix(cols[idx[x]].name) !== namePrefix(cols[idx[x - 1]].name) && Math.abs(x - ideal) < bd) { bd = Math.abs(x - ideal); best = x; }
      }
      cuts.push(Math.max(prev + 1, Math.min(m - (parts - q), best)));
    }
    cuts.push(m);
    for (let q = 0; q < parts; q++) {
      const part = idx.slice(cuts[q], cuts[q + 1]);
      const pre = []; part.forEach(i => { const p = namePrefix(cols[i].name); if (p && pre[pre.length - 1] !== p) pre.push(p); });
      const clean = pre.length > 0 && part.every(i => namePrefix(cols[i].name));
      const tok0 = i => String(cols[i].name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || String(q + 1);
      const fa = tok0(part[0]), fz = tok0(part[part.length - 1]);
      const tag = clean ? (pre.length === 1 ? pre[0] : pre.length <= 3 ? pre.join(', ') : pre[0] + ' to ' + pre[pre.length - 1]) : fa === fz ? fa : `${fa} to ${fz}`;
      const stag = clean ? (pre.length === 1 ? pre[0] : pre[0] + '–' + pre[pre.length - 1]) : fa === fz ? fa : fa + '–' + fz;
      groups.push({ key: key + '-' + q, family: key, label: `${label}: ${tag}`, short: short + ' ' + stag.toUpperCase(), familyShort: short, cols: part });
    }
  });
  const groupOf = new Array(n).fill(-1), order = [];
  groups.forEach((g, gi) => {
    let worst = -1, poor = 0, fair = 0, sum = 0, cnt = 0;
    for (const i of g.cols) {
      groupOf[i] = gi; order.push(i);
      const s = cols[i].score; if (s === null || s === undefined || isNaN(s)) continue;
      cnt++; sum += s; if (s < 0.95) poor++; else if (s < 0.99) fair++;
      if (worst < 0 || s < cols[worst].score) worst = i;
    }
    Object.assign(g, { worst, worstScore: worst < 0 ? null : cols[worst].score, mean: cnt ? sum / cnt : null, poor, fair });
  });
  return { grouped: true, groups, order, groupOf };
}
/* Angles for the ring, clockwise from the top. Each arc is sized by its column count, never thinner
   than minFrac of the circle. unfold = index of the open group (or -1), t = 0..1 how far it has opened.
   The open group widens around its own centre and the others close up to make room. */
function ringSpans(groups, unfold, t, opts) {
  opts = opts || {};
  const minFrac = opts.minFrac || 0.035, perCol = opts.perCol || 0.105, maxOpen = opts.maxOpen || Math.PI * 1.5, two = Math.PI * 2;
  const n = groups.reduce((a, g) => a + g.cols.length, 0) || 1;
  const w0 = groups.map(g => Math.max(minFrac, g.cols.length / n)), tot0 = w0.reduce((a, b) => a + b, 0);
  const f0 = w0.map(w => w / tot0 * two);
  let f = f0;
  const open = unfold >= 0 && unfold < groups.length && t > 0;
  if (open) {
    const want = Math.min(maxOpen, Math.max(f0[unfold], groups[unfold].cols.length * perCol, Math.PI * 0.55));
    const restNow = two - f0[unfold], restWant = two - want;
    f = f0.map((a, k) => a + ((k === unfold ? want : a / restNow * restWant) - a) * t);
  }
  let a = -Math.PI / 2;
  const spans = f.map(w => { const s = { a0: a, a1: a + w }; a += w; return s; });
  if (open) {
    let c0 = -Math.PI / 2; for (let k = 0; k < unfold; k++) c0 += f0[k];
    c0 += f0[unfold] / 2;
    const shift = c0 - (spans[unfold].a0 + spans[unfold].a1) / 2;
    spans.forEach(s => { s.a0 += shift; s.a1 += shift; });
  }
  return spans;
}

/* ---------- normalize rows from any reader ---------- */
function cellToString(v, localDates) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    if (localDates) { // spreadsheet dates are wall-clock values in the viewer's time zone
      const d = new Date(Math.round(v.getTime() / 1000) * 1000), p2 = n => String(n).padStart(2, '0');
      const day = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      return d.getHours() || d.getMinutes() || d.getSeconds() ? day + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) : day;
    }
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$/, '').replace(/Z$/, '');
  }
  if (v instanceof Uint8Array) return '[binary ' + v.length + ' bytes]';
  try { return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x); } catch (e) { return String(v); }
}

/* reservoir sampler for streamed rows */
function Reservoir(cap, rand) {
  this.cap = cap; this.rows = []; this.seen = 0; this.rand = rand || Math.random;
}
Reservoir.prototype.push = function (row) {
  this.seen++;
  if (this.rows.length < this.cap) this.rows.push(row);
  else { const j = Math.floor(this.rand() * this.seen); if (j < this.cap) this.rows[j] = row; }
};

/* ---------- synthetic P&C claims sample (deterministic) ---------- */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function sampleClaimsCSV(seed) {
  const rnd = mulberry32(seed || 20261110);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const wpick = (items) => { const tot = items.reduce((a, x) => a + x[1], 0); let r = rnd() * tot; for (const [v, w] of items) { if ((r -= w) < 0) return v; } return items[items.length - 1][0]; };
  const randn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pad = (n, w) => String(n).padStart(w, '0');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const mdy = t => { const d = new Date(t); return pad(d.getUTCMonth() + 1, 2) + '/' + pad(d.getUTCDate(), 2) + '/' + d.getUTCFullYear(); };

  const LOB = [['Personal Auto', 34, 'PA', 8.4], ['Homeowners', 22, 'HO', 9.0], ['Commercial Auto', 14, 'CA', 9.3], ['General Liability', 11, 'GL', 9.6], ['Workers Comp', 12, 'WC', 8.9], ['Commercial Property', 7, 'CP', 9.8]];
  const STATES = [['TX', 22, 75, 79, '214 469 512 713 817 972'], ['CA', 15, 90, 96, '213 310 415 619 714 916'], ['FL', 12, 32, 34, '305 407 561 727 813 904'], ['NY', 9, 10, 14, '212 315 516 585 718 914'],
    ['IL', 7, 60, 62, '217 312 630 708 773 847'], ['GA', 6, 30, 31, '404 470 678 706 770 912'], ['PA', 6, 15, 19, '215 267 412 610 717 814'], ['OH', 5, 43, 45, '216 330 513 614 740 937'],
    ['NJ', 5, 7, 8, '201 609 732 856 908 973'], ['AZ', 5, 85, 86, '480 520 602 623 928 480'], ['NC', 4, 27, 28, '252 336 704 828 910 919'], ['CO', 4, 80, 81, '303 719 720 970 303 720']];
  const FIRST = 'Ava Liam Noah Emma Mia Lucas Aria Mateo Zoe Ethan Nora Leo Maya Owen Isla Kai Ruby Eli Lena Omar Priya Arjun Sofia Diego Hana Yusuf Chloe Theo Iris Jonah Amara Felix Nina Ravi Lucia Marco Tess Ivan Elena Sam'.split(' ');
  const LAST = 'Okafor Brennan Castillo Nguyen Whitfield Patel Moreau Haddad Lindqvist Romero Takahashi Osei Delgado Kowalski Fischer Abbott Mensah Varga Holloway Ibarra Quinlan Sato Rahman Ferreira Ashby Novak Dunmore Pereira Kimura Ellison'.split(' ');
  const DOMAINS = ['example.com', 'example.net', 'example.org', 'mail.example.com'];
  const ADJ = 'R. Okonkwo|D. Harlan|M. Esposito|J. Whitaker|S. Lindgren|A. Marquez|T. Bhatt|K. Sorensen|L. Fairbanks|P. Yamada|C. Abernathy|N. Oyelaran|B. Castellano|E. Drummond|G. Petrov|H. Calloway|V. Raman|W. Thornbury|F. Quintero|Y. Adeyemi|O. Halvorsen|I. Kaczmarek|U. Delacroix|Z. Montoya'.split('|');

  const START = Date.UTC(2023, 0, 1), END = Date.UTC(2025, 9, 31), DAY = 86400000;
  const N = 2000;
  // policy pool so a policy can carry several claims
  const policies = [];
  for (let i = 0; i < 1350; i++) { const l = wpick(LOB.map(x => [x, x[1]])); const s = wpick(STATES.map(x => [x, x[1]])); policies.push({ lob: l, st: s, no: l[2] + '-' + s[0] + '-' + pad(1000000 + Math.floor(rnd() * 8999999), 7) }); }

  const rows = [];
  for (let i = 0; i < N; i++) {
    const pol = pick(policies), lobRow = pol.lob, stRow = pol.st;
    const loss = START + Math.floor(rnd() * ((END - START) / DAY)) * DAY;
    const lag = Math.floor(Math.abs(randn()) * 9 + rnd() * 4);
    const report = loss + lag * DAY;
    const f = pick(FIRST), l = pick(LAST);
    const status = wpick([['Open', 35], ['Closed', 50], ['Reopened', 7], ['Pending', 8]]);
    const sev = Math.exp(lobRow[3] + randn() * 1.05);
    let paid = status === 'Closed' ? sev : status === 'Pending' ? 0 : sev * (0.1 + rnd() * 0.5);
    let reserve = status === 'Closed' ? 0 : sev * (0.4 + rnd() * 0.9);
    if (rnd() < 0.06 && status === 'Closed') paid = 0; // closed without payment
    rows.push({
      claim_id: 'CLM-' + new Date(loss).getUTCFullYear() + '-' + pad(100001 + i, 6),
      policy_number: pol.no,
      claimant_email: (f + '.' + l).toLowerCase() + (rnd() < 0.3 ? Math.floor(rnd() * 90 + 10) : '') + '@' + pick(DOMAINS),
      claimant_phone: '(' + pick(stRow[4].split(' ')) + ') 555-01' + pad(Math.floor(rnd() * 100), 2),
      claimant_zip: pad(stRow[2] * 1000 + Math.floor(rnd() * ((stRow[3] - stRow[2] + 1) * 1000)), 5),
      loss_date: iso(loss), report_date: iso(report),
      line_of_business: lobRow[0], state: stRow[0],
      paid_amount: paid.toFixed(2), reserve_amount: reserve.toFixed(2),
      claim_status: status, adjuster: pick(ADJ)
    });
  }
  // ---- seeded data quality issues ----
  const idxs = (k) => { const s = new Set(); while (s.size < k) s.add(Math.floor(rnd() * N)); return Array.from(s); };
  idxs(118).forEach(i => rows[i].adjuster = '');
  idxs(74).forEach(i => rows[i].claimant_phone = '');
  idxs(41).forEach(i => rows[i].reserve_amount = '');
  idxs(36).forEach(i => rows[i].claimant_email = '');
  idxs(22).forEach(i => rows[i].claimant_email = pick(['N/A', 'n/a', 'none']));
  idxs(48).forEach(i => { const e = rows[i].claimant_email; if (!e.includes('@')) return; const [u, d] = e.split('@');
    rows[i].claimant_email = pick([u + '.' + d, u + '@' + d.split('.')[0], u + '@@' + d, u + '@' + d.replace('.', '..'), u + ' @' + d, u + '@' + d + ','] ); });
  idxs(31).forEach(i => { const p = rows[i].claimant_phone; if (!p) return; const d = p.replace(/\D/g, ''); rows[i].claimant_phone = pick([d.slice(3, 6) + '-' + d.slice(6), d.slice(0, 9), '555-01' + d.slice(-2)]); });
  idxs(160).forEach(i => { const p = rows[i].claimant_phone; if (!p) return; const d = p.replace(/\D/g, ''); rows[i].claimant_phone = rnd() < 0.6 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : d; });
  idxs(19).forEach(i => rows[i].claimant_zip = pick([rows[i].claimant_zip.slice(0, 4), rows[i].claimant_zip + '1', '00000-', 'TX750']));
  idxs(33).forEach(i => { const loss = Date.parse(rows[i].loss_date); rows[i].report_date = iso(loss - (1 + Math.floor(rnd() * 60)) * DAY); });
  idxs(4).forEach(i => rows[i].report_date = iso(Date.UTC(2027, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27))));
  idxs(44).forEach(i => rows[i].loss_date = mdy(Date.parse(rows[i].loss_date)));
  idxs(3).forEach(i => rows[i].loss_date = '');
  idxs(13).forEach(i => rows[i].paid_amount = (-Math.abs(Number(rows[i].paid_amount) || 850) * (0.2 + rnd())).toFixed(2));
  idxs(26).forEach(i => { const v = Number(rows[i].paid_amount); if (v > 0) rows[i].paid_amount = '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); });
  idxs(9).forEach(i => rows[i].reserve_amount = (2500000 + rnd() * 7300000).toFixed(2));
  idxs(4).forEach(i => rows[i].state = 'XX');
  idxs(3).forEach(i => rows[i].state = 'Tex');
  idxs(7).forEach(i => rows[i].state = rows[i].state.toLowerCase());
  idxs(12).forEach(i => rows[i].claim_status = 'closed');
  idxs(5).forEach(i => rows[i].claim_status = 'CLOSED');
  idxs(18).forEach(i => rows[i].line_of_business = pick(['personal auto', 'PERSONAL AUTO', 'Commercial  Auto', 'workers comp', 'Homeowners ']));
  idxs(21).forEach(i => { if (rows[i].adjuster) rows[i].adjuster = rows[i].adjuster + ' '; });
  idxs(2).forEach(i => rows[i].claim_id = '');
  // duplicate claim ids on different claims
  idxs(17).forEach(i => { const j = Math.floor(rnd() * N); if (j !== i && rows[j].claim_id) rows[i].claim_id = rows[j].claim_id; });
  // exact duplicate rows (double-loaded records)
  idxs(7).forEach(i => rows.splice(Math.floor(rnd() * rows.length), 0, Object.assign({}, rows[i])));

  const cols = Object.keys(rows[0]);
  const q = v => /[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => q(String(r[c]))).join(',')).join('\n') + '\n';
}

const api = { profileTable, columnGroups, columnFamily, ringSpans, GROUP_AT, profileColumn, parseNum, parseDate, inferType, nameHints, cellToString, Reservoir, sampleClaimsCSV, cleanHeaders, WEIGHTS, SCORE, MAX_ROWS, TYPE_META, NULL_TOKENS, US_STATES, isEmail, isPhone, isZip, isUuid, isUrl, isState, isBool, shapeOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DQ = api;
})(typeof window !== 'undefined' ? window : globalThis);

