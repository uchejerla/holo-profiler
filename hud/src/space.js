/* Holo space: a 3D field of records and columns you orbit, pinch, zoom and throw panels around in. Canvas 2D, own projection. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-US');
const nfc = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SEV_COL = { critical: '#ff5a7a', high: '#ffbe55', medium: '#b48cff', low: '#5fe1ff' };
const CAT_COL = ['#5fe1ff', '#b48cff', '#3dfcb4', '#ffbe55', '#ff8bd1', '#7aa8ff', '#e8f27a', '#ff9a6b', '#9af0ff', '#c9b6ff'];
const MISSING = -1.4, OUT = 2.4;
const DAY = 86400000;

const root = $('space'), cv = $('spaceCv'), ctx = cv.getContext ? cv.getContext('2d') : null;
const S = {
  open: false, W: 0, H: 0, dpr: 1, F: 400, raf: 0, last: 0, time: 0,
  cam: { yaw: -0.65, pitch: 0.42, dist: 6.2, tx: 0, ty: 0, tz: 0 }, vel: { yaw: 0, pitch: 0, px: 0, py: 0 },
  anim: null, auto: !reduced, interacted: false,
  key: null, n: 0, rowsIdx: null, pos: null, scr: null, ok: null, colorKey: null, groups: [],
  axes: { x: null, y: null, z: null }, axisInfo: {}, colorBy: 'rules',
  failAny: null, failCrit: null, focusRule: null, focusSet: null,
  sel: null, hover: null, expanded: null, nodes: [], dirtyColors: true,
  G: null, gnodes: [], openGroup: null, nearGroup: null
};

/* ---------- data from the page ---------- */
function data() { const R = window.HoloRules && HoloRules.state; return R && R.p ? R : null; }

function hashRow(r, k) { let h = (r + 1) * 2654435761 ^ (k * 40503); h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return ((h >>> 0) % 10000) / 10000; }

function axisFor(name) {
  const R = data(); const H = R.headers, rows = R.rows;
  if (name === '__row') return { name: 'row order', kind: 'row', map: (raw, r) => rows.length > 1 ? -1 + 2 * r / (rows.length - 1) : 0, lo: '1', hi: nf0.format(rows.length), hasMissing: false };
  const ci = H.indexOf(name), col = R.p.cols.find(c => c.name === name);
  if (ci < 0 || !col) return axisFor('__row');
  const isNull = DQR.isNull;
  if (col.base === 'number' || col.type === 'date') {
    const isDate = col.type === 'date';
    const sk = !isDate && col.num && col.num.skewed;
    const tf = v => sk ? Math.sign(v) * Math.log10(1 + Math.abs(v)) : v;
    const parse = s => { if (isDate) { const d = DQ.parseDate(String(s).trim(), true); return d ? d.t : null; } const p = DQ.parseNum(String(s)); return p ? p.v : null; };
    const vals = []; const step = Math.max(1, Math.floor(rows.length / 20000));
    for (let r = 0; r < rows.length; r += step) { const x = rows[r][ci]; if (isNull(x)) continue; const v = parse(x); if (v !== null && (!isDate || new Date(v).getUTCFullYear() >= 1900)) vals.push(tf(v)); }
    vals.sort((a, b) => a - b);
    const q = f => vals.length ? vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * f)))] : 0;
    let lo = q(0.01), hi = q(0.99); if (hi === lo) { lo -= 1; hi += 1; }
    const inv = t => sk ? Math.sign(t) * (Math.pow(10, Math.abs(t)) - 1) : t;
    const lab = t => isDate ? new Date(t).toISOString().slice(0, 10) : nfc.format(inv(t));
    let missing = false;
    const map = (raw) => { if (isNull(raw)) { missing = true; return MISSING; } const v = parse(raw); if (v === null) { missing = true; return MISSING; } const m = -1 + 2 * (tf(v) - lo) / (hi - lo); return Math.max(-OUT, Math.min(OUT, m)); };
    const info = { name, kind: isDate ? 'date' : 'number', log: sk, map, lo: lab(lo), hi: lab(hi) };
    Object.defineProperty(info, 'hasMissing', { get: () => missing });
    return info;
  }
  // categorical lanes
  const counts = new Map(); for (const row of rows) { const x = row[ci]; if (isNull(x)) continue; const v = String(x).trim(); counts.set(v, (counts.get(v) || 0) + 1); }
  const lanes = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0]);
  const laneIx = new Map(lanes.map((v, i) => [v, i])); const L = Math.max(1, lanes.length - 1 + (counts.size > lanes.length ? 1 : 0));
  let missing = false;
  const map = (raw, r, k) => { if (isNull(raw)) { missing = true; return MISSING; } const v = String(raw).trim(); const i = laneIx.has(v) ? laneIx.get(v) : lanes.length; const base = -1 + 2 * i / Math.max(1, L); return base + (hashRow(r, k) - 0.5) * (1.4 / Math.max(2, L + 1)); };
  const info = { name, kind: 'category', lanes, map, lo: lanes[0] || '', hi: counts.size > lanes.length ? 'other' : (lanes[lanes.length - 1] || '') };
  Object.defineProperty(info, 'hasMissing', { get: () => missing });
  return info;
}

function defaultAxes() {
  const R = data(); const cols = R.p.cols;
  const dates = cols.filter(c => c.type === 'date' && c.present);
  const nums = cols.filter(c => c.base === 'number' && c.num).sort((a, b) => (b.hints.amount ? 1 : 0) - (a.hints.amount ? 1 : 0));
  const cats = cols.filter(c => c.categorical && c.distinct <= 12);
  const pool = [...dates.slice(0, 1), ...nums.slice(0, 2), ...dates.slice(1), ...nums.slice(2), ...cats].map(c => c.name);
  while (pool.length < 3) pool.push('__row');
  return { x: pool[0], y: pool[1], z: pool[2] };
}

function build() {
  const R = data(); if (!R) return false;
  const key = R.p.headers.join('\u0001') + '|' + R.rows.length + '|' + (R.src && R.src.name);
  const small = Math.min(innerWidth, innerHeight) < 600 || matchMedia('(pointer: coarse)').matches;
  const cap = small ? 6000 : 16000;
  if (S.key !== key) {
    S.key = key; S.axes = defaultAxes(); S.sel = null; S.expanded = null; S.focusRule = null; S.colorBy = 'rules';
    computeFails();
    const n = R.rows.length; let idx;
    if (n <= cap) { idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; }
    else {
      const bad = [], good = []; for (let i = 0; i < n; i++) (S.failAny[i] ? bad : good).push(i);
      const takeBad = Math.min(bad.length, Math.floor(cap / 2));
      const pick = (arr, k) => { const a = arr.slice(); for (let i = 0; i < k; i++) { const j = i + Math.floor(hashRow(i, 7) * (a.length - i)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a.slice(0, k); };
      idx = Uint32Array.from(pick(bad, takeBad).concat(pick(good, cap - takeBad)).sort((a, b) => a - b));
    }
    S.rowsIdx = idx; S.n = idx.length; S.pos = new Float32Array(S.n * 3); S.scr = new Float32Array(S.n * 2); S.ok = new Uint8Array(S.n);
    buildNodes(); fillAxisSelects(); fillColorSelect();
    $('spViewNote').textContent = S.G.grouped
      ? `Each point is one record. Blanks sit on the red plane outside the cube. The ring below holds ${S.gnodes.length} groups of related columns (${R.p.cols.length} in all). Zoom or pinch into a group, or double-click it, to split it into its columns; Escape folds it back.`
      : 'Each point is one record. Blanks sit on the red plane outside the cube. The ring below holds one node per column; double-click a node to open its distribution.';
    if (spSearch) spSearch.refresh();
  }
  layout(); S.dirtyColors = true; return true;
}
function layout() {
  const R = data(); const H = R.headers, rows = R.rows;
  const ax = ['x', 'y', 'z'].map((k, kk) => { const a = axisFor(S.axes[k]); S.axisInfo[k] = a; return { a, ci: H.indexOf(S.axes[k]), kk }; });
  for (let i = 0; i < S.n; i++) {
    const r = S.rowsIdx[i], row = rows[r];
    for (const { a, ci, kk } of ax) S.pos[i * 3 + kk] = a.map(ci >= 0 ? row[ci] : '', r, kk);
  }
}
function computeFails() {
  const R = data(); const n = R.rows.length;
  S.failAny = new Uint8Array(n); S.failCrit = new Uint8Array(n);
  for (const r of R.rules) {
    if (r.status === 'rejected') continue; const x = R.results[r.id]; if (!x || x.error) continue;
    for (const i of x.failRows) { S.failAny[i] = 1; if (r.severity === 'critical') S.failCrit[i] = 1; }
  }
  if (S.focusRule) { const x = R.results[S.focusRule]; S.focusSet = x && !x.error ? new Set(x.failRows) : null; if (!S.focusSet) S.focusRule = null; }
}
const RAD = 3.1, WALL_Q = 6, WALL_GAP = 0.42;
const scoreHex = sc => sc === null || sc === undefined ? '#4f7690' : sc >= 0.99 ? '#3dfcb4' : sc >= 0.95 ? '#ffbe55' : '#ff5a7a';
const ringPos = a => [RAD * Math.cos(a), -1.15 + 0.12 * Math.sin(a * 3), RAD * Math.sin(a)];
function buildNodes() {
  const R = data(); const cols = R.p.cols, n = cols.length;
  S.G = DQ.columnGroups(cols); S.openGroup = null; S.nearGroup = null; S.gnodes = [];
  S.nodes = cols.map((c, i) => {
    const a = i / n * Math.PI * 2;
    const issues = c.issues.filter(x => x.sev !== 'info').length;
    return { i, name: c.name, col: c, pos: ringPos(a), color: scoreHex(c.score), issues, vis: 1 };
  });
  if (!S.G.grouped) return;
  // Wide file: one node per group on the ring. Each group's columns wait behind it on a small wall
  // (rows of WALL_Q, rising above the ring, facing outwards) and fan out when the group opens.
  const spans = DQ.ringSpans(S.G.groups, -1, 0);
  S.gnodes = S.G.groups.map((g, gi) => {
    const a = (spans[gi].a0 + spans[gi].a1) / 2, home = ringPos(a);
    const tx = -Math.sin(a), tz = Math.cos(a), m = g.cols.length, q = Math.min(WALL_Q, m), rows = Math.ceil(m / q);
    g.cols.forEach((ci, k) => {
      const row = Math.floor(k / q), inRow = row === rows - 1 ? m - row * q : q, col = k - row * q;
      const off = (col - (inRow - 1) / 2) * WALL_GAP, up = 0.5 + row * WALL_GAP;
      const nd = S.nodes[ci]; nd.home = home; nd.g = gi;
      nd.wall = [home[0] + tx * off, home[1] + up, home[2] + tz * off];
      nd.pos = home.slice(); nd.vis = 0;
    });
    const wallC = [home[0], home[1] + 0.5 + (rows - 1) * WALL_GAP / 2, home[2]];
    return { gi, g, a, pos: home, wallC, rows, color: scoreHex(g.worstScore), split: 0, name: g.label };
  });
}
/* which group is open: one opened on purpose (double-click, search, inspector), else the one the camera has moved in close to */
function updateSplit(dt) {
  if (!S.G || !S.G.grouped) return;
  const m = Math.min(S.W, S.H);
  if (S.openGroup !== null && !S.anim) { const gn = S.gnodes[S.openGroup]; const d = depthOf(gn.wallC); if (d > 6.6 || S.cam.dist > 5.4) S.openGroup = null; }
  let near = null;
  if (S.openGroup === null) {
    let best = Infinity;
    S.gnodes.forEach(gn => {
      if (!project(gn.pos[0], gn.pos[1], gn.pos[2], tmp)) return;
      const d = depthOf(gn.pos), sd = Math.hypot(tmp[0] - S.W / 2, tmp[1] - S.H / 2);
      // only once the camera has moved in from the overview (dist 6.2), so auto-rotate never pops groups open
      const keep = S.nearGroup === gn.gi, okC = keep ? 5.6 : 4.6, okD = keep ? 4.6 : 3.8, okS = (keep ? 0.42 : 0.3) * m;
      if (S.cam.dist < okC && d < okD && sd < okS && sd + d * 40 < best) { best = sd + d * 40; near = gn.gi; }
    });
  }
  S.nearGroup = near;
  const active = S.openGroup !== null ? S.openGroup : near;
  const k = reduced ? 1 : Math.min(1, dt / 140);
  for (const gn of S.gnodes) {
    const target = gn.gi === active ? 1 : 0;
    gn.split += (target - gn.split) * k; if (Math.abs(gn.split - target) < 0.002) gn.split = target;
    const e = gn.split < 0.5 ? 4 * gn.split ** 3 : 1 - Math.pow(-2 * gn.split + 2, 3) / 2;
    for (const ci of gn.g.cols) { const nd = S.nodes[ci]; for (let q = 0; q < 3; q++) nd.pos[q] = nd.home[q] + (nd.wall[q] - nd.home[q]) * e; nd.vis = e; }
  }
}
function depthOf(p) { const x = p[0] - S.cam.tx, y = p[1] - S.cam.ty, z = p[2] - S.cam.tz; const z1 = x * sy + z * cy; return y * sp + z1 * cp + S.cam.dist; }
function openGroup(gi, fly) {
  const gn = S.gnodes[gi]; if (!gn) return;
  S.openGroup = gi; S.sel = { kind: 'group', gi }; inspectGroup(gi);
  if (fly !== false) flyTo({ tx: gn.wallC[0], ty: gn.wallC[1], tz: gn.wallC[2], dist: Math.max(2.6, Math.min(4.6, 2.2 + gn.rows * 0.42)), yaw: -gn.a + Math.PI / 2, pitch: 0.12 }, 900);
}
function focusColumn(i) {
  const nd = S.nodes[i]; if (!nd) return;
  S.expanded = null;
  if (S.G && S.G.grouped) {
    S.openGroup = nd.g; const gn = S.gnodes[nd.g];
    S.sel = { kind: 'col', i }; inspectCol(i);
    flyTo({ tx: nd.wall[0], ty: nd.wall[1], tz: nd.wall[2], dist: 2.4, yaw: -gn.a + Math.PI / 2, pitch: 0.1 }, 900);
  } else {
    S.sel = { kind: 'col', i }; inspectCol(i);
    const ang = Math.atan2(nd.pos[2], nd.pos[0]);
    flyTo({ tx: nd.pos[0], ty: nd.pos[1] + 0.3, tz: nd.pos[2], dist: 2.6, yaw: -ang + Math.PI / 2, pitch: 0.2 }, 900);
  }
  S.flashCol = i; S.flashUntil = performance.now() + 1800;
}

/* ---------- colours ---------- */
function recolor() {
  const R = data(); if (!R) return;
  S.dirtyColors = false;
  const groups = new Map();
  const put = (k, color, size, alpha, i) => { let g = groups.get(k); if (!g) { g = { color, size, alpha, idx: [] }; groups.set(k, g); } g.idx.push(i); };
  let catMap = null, numA = null;
  if (S.colorBy !== 'rules') {
    const ci = R.headers.indexOf(S.colorBy), col = R.p.cols.find(c => c.name === S.colorBy);
    if (col && (col.base === 'number' || col.type === 'date')) numA = { a: axisFor(S.colorBy), ci };
    else if (ci >= 0) { const top = (col ? col.top : []).slice(0, CAT_COL.length).map(t => t.v); catMap = { ci, ix: new Map(top.map((v, k) => [v, k])), top }; }
  }
  for (let i = 0; i < S.n; i++) {
    const r = S.rowsIdx[i];
    if (S.focusRule) {
      if (S.focusSet.has(r)) put('focus', '#ff5a7a', 3.2, 1, i); else put('dim', '#5fe1ff', 1.6, 0.13, i);
      continue;
    }
    if (S.colorBy === 'rules') {
      if (S.failCrit[r]) put('crit', '#ff5a7a', 2.8, 0.95, i); else if (S.failAny[r]) put('fail', '#ffbe55', 2.4, 0.85, i); else put('pass', '#5fe1ff', 1.8, 0.55, i);
    } else if (catMap) {
      const raw = R.rows[r][catMap.ci]; const v = DQR.isNull(raw) ? null : String(raw).trim();
      const k = v === null ? -2 : catMap.ix.has(v) ? catMap.ix.get(v) : -1;
      put('c' + k, k >= 0 ? CAT_COL[k] : k === -1 ? '#86afc8' : '#ff5a7a', 2, k === -2 ? 0.9 : 0.7, i);
    } else if (numA) {
      const m = numA.a.map(R.rows[r][numA.ci], r, 0);
      if (m === MISSING) { put('nm', '#ff5a7a', 2.2, 0.9, i); continue; }
      const t = Math.max(0, Math.min(1, (m + 1) / 2)); const b = Math.min(7, Math.floor(t * 8));
      const cols = ['#2f86ff', '#3fa0ff', '#5fe1ff', '#7ff0e0', '#b48cff', '#d48cff', '#ff8bd1', '#ff5a7a'];
      put('n' + b, cols[b], 2, 0.75, i);
    }
  }
  const order = ['dim', 'pass'];
  S.groups = Array.from(groups.entries()).sort((a, b) => (order.indexOf(b[0]) - order.indexOf(a[0]))).map(e => Object.assign(e[1], { key: e[0], idx: Uint32Array.from(e[1].idx) }));
  renderLegend(catMap, numA);
}

/* ---------- projection ---------- */
let cy = 1, sy = 0, cp = 1, sp = 0;
function setRot() { cy = Math.cos(S.cam.yaw); sy = Math.sin(S.cam.yaw); cp = Math.cos(S.cam.pitch); sp = Math.sin(S.cam.pitch); }
function project(x, y, z, out) {
  x -= S.cam.tx; y -= S.cam.ty; z -= S.cam.tz;
  const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
  const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
  const d = z2 + S.cam.dist;
  if (d < 0.15) return false;
  const s = S.F / d; out[0] = S.W / 2 + x1 * s; out[1] = S.H / 2 - y2 * s; out[2] = s; return true;
}
function camAxes() { // world-space right and up vectors of the camera
  return { right: [cy, 0, -sy], up: [-sy * sp, cp, -cy * sp] };
}

/* ---------- draw ---------- */
const tmp = [0, 0, 0], tmp2 = [0, 0, 0];
function line3(a, b, stroke, w) { if (!project(a[0], a[1], a[2], tmp) || !project(b[0], b[1], b[2], tmp2)) return; ctx.strokeStyle = stroke; ctx.lineWidth = w || 1; ctx.beginPath(); ctx.moveTo(tmp[0], tmp[1]); ctx.lineTo(tmp2[0], tmp2[1]); ctx.stroke(); }
function text3(p, str, color, size, align) { if (!project(p[0], p[1], p[2], tmp)) return; ctx.fillStyle = color; ctx.font = `${size || 11}px "JetBrains Mono", ui-monospace, monospace`; ctx.textAlign = align || 'left'; ctx.fillText(str, tmp[0], tmp[1]); }
let glow = null;
function glowSprite() {
  if (glow) return glow; glow = document.createElement('canvas'); glow.width = glow.height = 64; const g = glow.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return glow;
}
function draw(now) {
  const W = S.W, H = S.H, d = S.dpr;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, W, H);
  setRot();
  // ambient glow behind the field
  if (project(0, 0, 0, tmp)) { const r = tmp[2] * 2.2; const g = ctx.createRadialGradient(tmp[0], tmp[1], 0, tmp[0], tmp[1], r); g.addColorStop(0, 'rgba(47,134,255,0.16)'); g.addColorStop(1, 'rgba(47,134,255,0)'); ctx.fillStyle = g; ctx.fillRect(tmp[0] - r, tmp[1] - r, r * 2, r * 2); }
  // floor grid and cube
  for (let k = -4; k <= 4; k++) { const t = k / 4; line3([-1, -1, t], [1, -1, t], 'rgba(95,225,255,0.07)'); line3([t, -1, -1], [t, -1, 1], 'rgba(95,225,255,0.07)'); }
  const E = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([a, b]) => line3(E[a], E[b], 'rgba(95,225,255,0.2)'));
  // axes
  const AX = { x: [[-1, -1, 1], [1.25, -1, 1]], y: [[-1, -1, 1], [-1, 1.25, 1]], z: [[-1, -1, 1], [-1, -1, -1.25]] };
  const axCol = { x: '#5fe1ff', y: '#b48cff', z: '#3dfcb4' };
  for (const k of ['x', 'y', 'z']) {
    const a = S.axisInfo[k]; if (!a) continue;
    line3(AX[k][0], AX[k][1], axCol[k], 1.4);
    text3(AX[k][1], (a.name || '') + (a.log ? ' (log)' : ''), axCol[k], 12);
    const lo = k === 'x' ? [-1, -1.12, 1.05] : k === 'y' ? [-1.08, -1, 1.05] : [-1.08, -1.12, 1];
    const hi = k === 'x' ? [1, -1.12, 1.05] : k === 'y' ? [-1.08, 1, 1.05] : [-1.08, -1.12, -1];
    text3(lo, String(a.lo).slice(0, 18), 'rgba(134,175,200,0.85)', 10, 'right'); text3(hi, String(a.hi).slice(0, 18), 'rgba(134,175,200,0.85)', 10, 'right');
    if (a.hasMissing) {
      const m = MISSING;
      const sq = k === 'x' ? [[m, -1, -1], [m, 1, -1], [m, 1, 1], [m, -1, 1]] : k === 'y' ? [[-1, m, -1], [1, m, -1], [1, m, 1], [-1, m, 1]] : [[-1, -1, m], [1, -1, m], [1, 1, m], [-1, 1, m]];
      for (let q = 0; q < 4; q++) line3(sq[q], sq[(q + 1) % 4], 'rgba(255,90,122,0.32)');
      text3(sq[1], 'missing ' + a.name, 'rgba(255,90,122,0.8)', 10);
    }
  }
  // points
  const pos = S.pos, scr = S.scr, ok = S.ok;
  for (let i = 0; i < S.n; i++) {
    let x = pos[i * 3] - S.cam.tx, y = pos[i * 3 + 1] - S.cam.ty, z = pos[i * 3 + 2] - S.cam.tz;
    const x1 = x * cy - z * sy, z1 = x * sy + z * cy, y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, dd = z2 + S.cam.dist;
    if (dd < 0.15) { ok[i] = 0; continue; }
    const s = S.F / dd; scr[i * 2] = W / 2 + x1 * s; scr[i * 2 + 1] = H / 2 - y2 * s; ok[i] = s > 0 ? Math.min(255, s) : 0;
  }
  ctx.globalCompositeOperation = 'lighter';
  const pulse = 0.75 + 0.25 * Math.sin(now / 380);
  for (const g of S.groups) {
    ctx.fillStyle = g.color; ctx.globalAlpha = g.key === 'focus' || g.key === 'crit' ? g.alpha * pulse : g.alpha;
    const zs = Math.max(0.7, Math.min(2.6, S.F / S.cam.dist / 120));
    const sz = g.size * zs, h = sz / 2, idx = g.idx;
    for (let k = 0; k < idx.length; k++) { const i = idx[k]; if (!ok[i]) continue; const px = scr[i * 2], py = scr[i * 2 + 1]; if (px < -4 || py < -4 || px > W + 4 || py > H + 4) continue; ctx.fillRect(px - h, py - h, sz, sz); }
    if (g.key === 'focus' || g.key === 'crit') { // halos
      const sp2 = glowSprite(); ctx.globalAlpha = (g.key === 'focus' ? 0.5 : 0.22) * pulse * Math.min(1, Math.sqrt(500 / Math.max(1, idx.length))); const r = sz * (g.key === 'focus' ? 4 : 3);
      for (let k = 0; k < idx.length && k < 4000; k++) { const i = idx[k]; if (!ok[i]) continue; ctx.drawImage(sp2, scr[i * 2] - r, scr[i * 2 + 1] - r, r * 2, r * 2); }
    }
  }
  // group nodes (wide files)
  const grouped = S.G && S.G.grouped;
  for (const gn of S.gnodes) {
    const axisCol = ['x', 'y', 'z'].find(k => { const c = S.nodes.find(n => n.name === S.axes[k]); return c && c.g === gn.gi; });
    if (axisCol && gn.split < 0.5) line3(gn.pos, AX[axisCol][1], 'rgba(214,244,255,0.14)');
    if (!project(gn.pos[0], gn.pos[1], gn.pos[2], tmp)) { gn.sx = -1e9; continue; }
    gn.sx = tmp[0]; gn.sy = tmp[1];
    const m = gn.g.cols.length, r = Math.max(7, Math.min(22, tmp[2] * 0.042 * (1.1 + Math.min(1, Math.sqrt(m) / 6)))); gn.r = r;
    const fade = 1 - gn.split * 0.65, isSel = S.sel && S.sel.kind === 'group' && S.sel.gi === gn.gi;
    ctx.globalAlpha = (isSel ? 0.95 : 0.65) * fade; ctx.drawImage(tintedGlow(gn.color), tmp[0] - r * 2, tmp[1] - r * 2, r * 4, r * 4);
    ctx.globalAlpha = fade; ctx.fillStyle = gn.color; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * 0.36, 0, Math.PI * 2); ctx.fill();
    // a segmented halo: one notch per column, poor ones in red
    const segs = Math.min(m, 48), cols = gn.g.cols;
    ctx.lineWidth = Math.max(1.2, r * 0.12);
    for (let k = 0; k < segs; k++) {
      const ci = cols[Math.floor(k / segs * m)], sc = S.nodes[ci].col.score;
      const a0 = now / 2400 + gn.gi + k / segs * Math.PI * 2, a1 = a0 + Math.PI * 2 / segs * 0.62;
      ctx.strokeStyle = sc !== null && sc < 0.95 ? '#ff5a7a' : sc !== null && sc < 0.99 ? '#ffbe55' : 'rgba(95,225,255,0.85)';
      ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * 0.82, a0, a1); ctx.stroke();
    }
    if (isSel) { ctx.strokeStyle = '#d6f4ff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * 1.15, 0, Math.PI * 2); ctx.stroke(); }
    // tethers from the group to its columns while it is open
    if (gn.split > 0.02) {
      ctx.globalAlpha = 0.35 * gn.split; ctx.strokeStyle = gn.color; ctx.lineWidth = 0.8;
      for (const ci of cols) { const nd = S.nodes[ci]; if (!project(nd.pos[0], nd.pos[1], nd.pos[2], tmp2)) continue; ctx.beginPath(); ctx.moveTo(gn.sx, gn.sy); ctx.lineTo(tmp2[0], tmp2[1]); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }
  // column nodes
  const sprite = glowSprite();
  for (const nd of S.nodes) {
    if (nd.vis < 0.03) { nd.sx = -1e9; continue; }
    const axisOf = ['x', 'y', 'z'].find(k => S.axes[k] === nd.name);
    if (axisOf) line3(nd.pos, AX[axisOf][1], 'rgba(214,244,255,0.18)');
    if (!project(nd.pos[0], nd.pos[1], nd.pos[2], tmp)) { nd.sx = -1e9; continue; }
    nd.sx = tmp[0]; nd.sy = tmp[1];
    const r = Math.max(grouped ? 4 : 5, Math.min(grouped ? 16 : 22, tmp[2] * (grouped ? 0.034 : 0.05) * (1 + Math.min(4, nd.issues) * 0.18)));
    nd.r = r;
    const isSel = S.sel && S.sel.kind === 'col' && S.sel.i === nd.i;
    const dimmed = S.expanded !== null && S.expanded !== nd.i && grouped ? 0.35 : 1;
    ctx.globalAlpha = (isSel ? 0.95 : 0.6) * nd.vis * dimmed; ctx.fillStyle = nd.color;
    ctx.drawImage(tintedGlow(nd.color), tmp[0] - r * 2.2, tmp[1] - r * 2.2, r * 4.4, r * 4.4);
    ctx.globalAlpha = nd.vis * dimmed; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * 0.42, 0, Math.PI * 2); ctx.fill();
    if (S.flashCol === nd.i && now < S.flashUntil) { const k = 1 - (S.flashUntil - now) / 1800; ctx.strokeStyle = '#d6f4ff'; ctx.globalAlpha = (1 - k) * nd.vis; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * (1.2 + k * 2.5), 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = nd.vis * dimmed;
    ctx.strokeStyle = nd.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * 0.9, now / 900 + nd.i, now / 900 + nd.i + 4.4); ctx.stroke();
    if (isSel) { ctx.strokeStyle = '#d6f4ff'; ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * 1.25, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // ring through nodes
  if (S.nodes.length > 1) { for (let k = 0; k < 96; k++) { const a0 = k / 96 * Math.PI * 2, a1 = (k + 1) / 96 * Math.PI * 2; line3([3.1 * Math.cos(a0), -1.15, 3.1 * Math.sin(a0)], [3.1 * Math.cos(a1), -1.15, 3.1 * Math.sin(a1)], 'rgba(95,225,255,0.12)'); } }
  ctx.textAlign = 'center';
  const placed = [], fits = (x, y, w, hh) => { for (const b of placed) if (x < b[0] + b[2] && b[0] < x + w && y < b[1] + b[3] && b[1] < y + hh) return false; placed.push([x, y, w, hh]); return true; };
  for (const nd of S.nodes) {
    if (nd.sx < -1e8 || nd.vis < 0.5) continue;
    const dense = grouped && nd.r < 9;
    ctx.globalAlpha = Math.min(1, (nd.vis - 0.5) * 2); ctx.fillStyle = 'rgba(214,244,255,0.85)'; ctx.font = `${dense ? 9.5 : 11}px "JetBrains Mono", ui-monospace, monospace`;
    const lim = grouped ? 14 : 18, txt = nd.name.length > lim ? nd.name.slice(0, lim - 1) + '…' : nd.name, ly = nd.sy + nd.r + (dense ? 10 : 13);
    if (grouped) { const w = ctx.measureText(txt).width; if (!fits(nd.sx - w / 2 - 2, ly - 10, w + 4, 12)) continue; }
    ctx.fillText(txt, nd.sx, ly);
  }
  const byNear = S.gnodes.filter(gn => gn.sx > -1e8).sort((a, b) => b.r - a.r);
  for (const gn of byNear) {
    const lab = gn.g.short + ' · ' + gn.g.cols.length; ctx.font = '600 11px "Chakra Petch", sans-serif';
    const w = ctx.measureText(lab).width, two = gn.g.poor && gn.split < 0.5;
    if (!fits(gn.sx - w / 2 - 3, gn.sy + gn.r + 3, w + 6, two ? 27 : 14)) continue;
    ctx.globalAlpha = 1 - gn.split * 0.5; ctx.font = '600 11px "Chakra Petch", sans-serif'; ctx.fillStyle = gn.color;
    ctx.fillText(lab, gn.sx, gn.sy + gn.r + 14);
    if (two) { ctx.font = '10px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(255,138,160,0.9)'; ctx.fillText(gn.g.poor + ' poor', gn.sx, gn.sy + gn.r + 27); }
  }
  ctx.globalAlpha = 1;
  // expanded column: distribution bars around the node
  if (S.expanded !== null) drawExpanded(now);
  // selection marker
  if (S.sel && S.sel.kind === 'row') { const i = S.sel.pi; if (i !== undefined && ok[i]) { const x = scr[i * 2], y = scr[i * 2 + 1]; ctx.strokeStyle = '#d6f4ff'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - 15, y); ctx.lineTo(x - 11, y); ctx.moveTo(x + 11, y); ctx.lineTo(x + 15, y); ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 11); ctx.moveTo(x, y + 11); ctx.lineTo(x, y + 15); ctx.stroke(); } }
  if (S.hover && S.hover.kind === 'row' && ok[S.hover.pi]) { const i = S.hover.pi; ctx.strokeStyle = 'rgba(214,244,255,0.7)'; ctx.beginPath(); ctx.arc(scr[i * 2], scr[i * 2 + 1], 6, 0, Math.PI * 2); ctx.stroke(); }
}
const tints = new Map();
function tintedGlow(color) {
  if (tints.has(color)) return tints.get(color);
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, color); gr.addColorStop(0.3, color + '88'); gr.addColorStop(1, color + '00');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); tints.set(color, c); return c;
}
function drawExpanded(now) {
  const nd = S.nodes[S.expanded]; if (!nd) return; const c = nd.col;
  let bins = null, labels = null;
  if (c.num) { bins = c.num.hist.bins; } else if (c.date) { bins = c.date.hist.bins; } else if (c.top && c.top.length) { bins = c.top.slice(0, 10).map(t => t.c); labels = c.top.slice(0, 10).map(t => t.v); }
  if (!bins) return;
  const mx = Math.max(1, ...bins), n = bins.length;
  const ang = Math.atan2(nd.pos[2], nd.pos[0]);
  const tx = -Math.sin(ang), tz = Math.cos(ang); // tangent of the ring
  const width = 1.6, grow = Math.min(1, (now - (S.expandedAt || now)) / 600);
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < n; k++) {
    const off = -width / 2 + width * (k + 0.5) / n;
    const base = [nd.pos[0] + tx * off, nd.pos[1] + 0.25, nd.pos[2] + tz * off];
    const h = 1.5 * bins[k] / mx * (reduced ? 1 : grow);
    line3(base, [base[0], base[1] + h, base[2]], k % 2 ? 'rgba(154,240,255,0.9)' : 'rgba(95,225,255,0.9)', Math.max(2, (S.F / S.cam.dist) * 0.012));
    if (labels && project(base[0], base[1] + h + 0.08, base[2], tmp)) { ctx.fillStyle = 'rgba(214,244,255,0.8)'; ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.fillText(String(labels[k]).slice(0, 10) + ' ' + nfc.format(bins[k]), tmp[0], tmp[1]); }
  }
  ctx.globalCompositeOperation = 'source-over';
  const lbl = c.num ? `${num(c.num.min)} to ${num(c.num.max)}` : c.date ? `${new Date(c.date.min).toISOString().slice(0, 10)} to ${new Date(c.date.max).toISOString().slice(0, 10)}` : `top ${bins.length} values`;
  text3([nd.pos[0], nd.pos[1] + 1.95, nd.pos[2]], `${c.name} · ${lbl}`, '#d6f4ff', 12, 'center');
}
const num = v => Math.abs(v) >= 1e4 ? nfc.format(v) : String(+v.toFixed(2));

/* ---------- loop ---------- */
function frame(now) {
  if (!S.open) return;
  S.raf = requestAnimationFrame(frame);
  const dt = Math.min(64, now - (S.last || now)); S.last = now;
  if (S.anim) {
    const t = Math.min(1, (now - S.anim.t0) / S.anim.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    for (const k of Object.keys(S.anim.to)) S.cam[k] = S.anim.from[k] + (S.anim.to[k] - S.anim.from[k]) * e;
    if (t >= 1) S.anim = null;
  } else if (!S.drag) {
    const f = Math.pow(0.9, dt / 16);
    S.cam.yaw += S.vel.yaw * dt / 16; S.cam.pitch = clampP(S.cam.pitch + S.vel.pitch * dt / 16);
    if (S.vel.px || S.vel.py) panBy(S.vel.px * dt / 16, S.vel.py * dt / 16);
    S.vel.yaw *= f; S.vel.pitch *= f; S.vel.px *= f; S.vel.py *= f;
    if (Math.abs(S.vel.yaw) < 1e-5) S.vel.yaw = 0; if (Math.abs(S.vel.pitch) < 1e-5) S.vel.pitch = 0; if (Math.abs(S.vel.px) < 0.01) S.vel.px = 0; if (Math.abs(S.vel.py) < 0.01) S.vel.py = 0;
    if (S.auto && !S.interacted) S.cam.yaw += 0.0012 * dt / 16;
  }
  if (S.dirtyColors) recolor();
  setRot(); updateSplit(dt);
  draw(now);
  stepPanels(dt);
}
const clampP = p => Math.max(-1.45, Math.min(1.45, p));
const clampD = d => Math.max(0.5, Math.min(16, d));
function panBy(dx, dy) { // screen pixels
  setRot(); const { right, up } = camAxes(); const k = S.cam.dist / S.F;
  S.cam.tx -= (right[0] * dx - up[0] * dy) * k; S.cam.ty -= (right[1] * dx - up[1] * dy) * k; S.cam.tz -= (right[2] * dx - up[2] * dy) * k;
}
function zoomAt(factor, mx, my) {
  setRot(); const { right, up } = camAxes();
  const ox = (mx - S.W / 2) / S.F * S.cam.dist, oy = -(my - S.H / 2) / S.F * S.cam.dist;
  const nd = clampD(S.cam.dist * factor); const f = 1 - nd / S.cam.dist;
  S.cam.tx += (right[0] * ox + up[0] * oy) * f; S.cam.ty += (right[1] * ox + up[1] * oy) * f; S.cam.tz += (right[2] * ox + up[2] * oy) * f;
  S.cam.dist = nd;
  // wide files: zooming in on a group node splits it open
  if (factor < 1 && S.G && S.G.grouped && S.openGroup === null && !S.anim && nd < 4.8) {
    let hit = null, bd = Infinity;
    for (const gn of S.gnodes) { if (gn.sx < -1e8) continue; const d = Math.hypot(gn.sx - mx, gn.sy - my); if (d < Math.max(40, gn.r * 1.8) && d < bd) { bd = d; hit = gn.gi; } }
    if (hit !== null) { S.vel.yaw = S.vel.pitch = S.vel.px = S.vel.py = 0; openGroup(hit); }
  }
}
function flyTo(to, dur) {
  const target = Object.assign({}, S.cam, to);
  if (to.dist !== undefined) target.dist = clampD(to.dist);
  // take the short way round
  const two = Math.PI * 2; target.yaw = S.cam.yaw + ((((target.yaw - S.cam.yaw) % two) + 3 * Math.PI) % two - Math.PI);
  if (reduced) { Object.assign(S.cam, target); return; }
  S.anim = { from: Object.assign({}, S.cam), to: target, t0: performance.now(), dur: dur || 800 };
  S.vel.yaw = S.vel.pitch = S.vel.px = S.vel.py = 0;
}
function resetView() { S.expanded = null; S.openGroup = null; flyTo({ yaw: -0.65, pitch: 0.42, dist: 6.2, tx: 0, ty: 0, tz: 0 }, 900); }

/* ---------- picking ---------- */
function pick(mx, my, touch) {
  const rr = touch ? 26 : 14;
  let bestCol = -1, bdc = Infinity;
  for (const nd of S.nodes) { if (nd.sx < -1e8 || nd.vis < 0.6) continue; const d = Math.hypot(nd.sx - mx, nd.sy - my); if (d < Math.max(S.G && S.G.grouped ? Math.min(rr, 18) : rr, nd.r) && d < bdc) { bdc = d; bestCol = nd.i; } }
  if (bestCol >= 0) return { kind: 'col', i: bestCol };
  for (const gn of S.gnodes) { if (gn.sx < -1e8) continue; const d = Math.hypot(gn.sx - mx, gn.sy - my); if (d < Math.max(rr, gn.r)) return { kind: 'group', gi: gn.gi }; }
  let best = -1, bd = rr * rr;
  const scr = S.scr, ok = S.ok;
  const dimmed = S.focusRule ? i => !S.focusSet.has(S.rowsIdx[i]) : null;
  for (let i = 0; i < S.n; i++) { if (!ok[i]) continue; const dx = scr[i * 2] - mx, dy = scr[i * 2 + 1] - my, d = (dx * dx + dy * dy) * (dimmed && dimmed(i) ? 2.5 : 1); if (d < bd) { bd = d; best = i; } }
  return best >= 0 ? { kind: 'row', pi: best, r: S.rowsIdx[best] } : null;
}

/* ---------- gestures ---------- */
const ptrs = new Map(); let gest = null, lastTap = { t: 0, x: 0, y: 0 }, hoverT = 0;
function local(e) { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); const p = local(e);
  ptrs.set(e.pointerId, { x: p.x, y: p.y, t: performance.now(), sx: p.x, sy: p.y, type: e.pointerType });
  S.interacted = true; S.anim = null; S.drag = true; hideTip();
  if (ptrs.size === 1) gest = { mode: (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit', moved: 0, t0: performance.now(), samples: [] };
  else if (ptrs.size === 2) { const [a, b] = Array.from(ptrs.values()); gest = { mode: 'pinch', span: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, moved: 99 }; }
  e.preventDefault();
});
cv.addEventListener('pointermove', e => {
  const p = local(e);
  if (!ptrs.has(e.pointerId)) { // hover
    if (e.pointerType === 'mouse' && performance.now() - hoverT > 40) { hoverT = performance.now(); const h = pick(p.x, p.y, false); S.hover = h; if (h) showTip(e, h); else hideTip(); cv.style.cursor = h ? 'pointer' : 'grab'; }
    return;
  }
  const q = ptrs.get(e.pointerId); const dx = p.x - q.x, dy = p.y - q.y; q.x = p.x; q.y = p.y;
  if (!gest) return;
  if (gest.mode === 'pinch' && ptrs.size >= 2) {
    const [a, b] = Array.from(ptrs.values()); const span = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (gest.span > 0 && span > 0) zoomAt(gest.span / span, mx, my);
    panBy(mx - gest.mx, my - gest.my); gest.span = span; gest.mx = mx; gest.my = my;
    return;
  }
  gest.moved += Math.abs(dx) + Math.abs(dy);
  const now = performance.now(); gest.samples.push({ t: now, dx, dy }); while (gest.samples.length && now - gest.samples[0].t > 90) gest.samples.shift();
  if (gest.mode === 'pan') panBy(dx, dy);
  else { S.cam.yaw -= dx * 0.0065; S.cam.pitch = clampP(S.cam.pitch + dy * 0.0065); }
  cv.style.cursor = 'grabbing';
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  const q = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  if (gest && gest.mode === 'pinch') { if (ptrs.size === 1) { const r = Array.from(ptrs.values())[0]; gest = { mode: 'pan', moved: 99, samples: [] }; r.x = r.x; } else if (!ptrs.size) { gest = null; S.drag = false; } return; }
  if (ptrs.size) return;
  S.drag = false; cv.style.cursor = 'grab';
  const g = gest; gest = null; if (!g) return;
  if (g.moved < (q.type === 'mouse' ? 5 : 10) && e.type === 'pointerup') { // a tap or click
    const now = performance.now(), touch = q.type !== 'mouse';
    const dbl = now - lastTap.t < 320 && Math.hypot(q.x - lastTap.x, q.y - lastTap.y) < 30;
    lastTap = { t: dbl ? 0 : now, x: q.x, y: q.y };
    if (dbl) onDouble(q.x, q.y, touch); else onTap(q.x, q.y, touch);
    return;
  }
  // inertia
  const s = g.samples, dt = s.length > 1 ? s[s.length - 1].t - s[0].t : 0;
  if (dt > 0 && !reduced) {
    const vx = s.reduce((a, x) => a + x.dx, 0) / dt * 16, vy = s.reduce((a, x) => a + x.dy, 0) / dt * 16;
    if (g.mode === 'pan') { S.vel.px = vx; S.vel.py = vy; } else { S.vel.yaw = -vx * 0.0065; S.vel.pitch = vy * 0.0065; }
  }
}
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !ptrs.size) { S.hover = null; hideTip(); } });
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => {
  e.preventDefault(); S.interacted = true; S.anim = null;
  const p = local(e); const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0016)), p.x, p.y);
}, { passive: false });
// Safari trackpad pinch
let gsScale = 1;
cv.addEventListener('gesturestart', e => { e.preventDefault(); gsScale = 1; });
cv.addEventListener('gesturechange', e => { e.preventDefault(); const p = local(e); zoomAt(gsScale / e.scale, p.x, p.y); gsScale = e.scale; });
cv.addEventListener('keydown', e => {
  const k = e.key; let used = true; S.interacted = true;
  if (k === 'ArrowLeft') S.vel.yaw = 0.03; else if (k === 'ArrowRight') S.vel.yaw = -0.03; else if (k === 'ArrowUp') S.vel.pitch = 0.025; else if (k === 'ArrowDown') S.vel.pitch = -0.025;
  else if (k === '+' || k === '=') zoomAt(0.8, S.W / 2, S.H / 2); else if (k === '-' || k === '_') zoomAt(1.25, S.W / 2, S.H / 2);
  else if (k === '0' || k === 'r' || k === 'R') resetView(); else used = false;
  if (used) e.preventDefault();
});

function onTap(x, y, touch) {
  const h = pick(x, y, touch);
  if (!h) { if (S.sel) { S.sel = null; inspectNone(); } return; }
  S.sel = h; if (h.kind === 'row') inspectRow(h.r); else if (h.kind === 'group') inspectGroup(h.gi); else inspectCol(h.i);
}
function onDouble(x, y, touch) {
  const h = pick(x, y, touch);
  if (h && h.kind === 'col') { expandCol(h.i); return; }
  if (h && h.kind === 'group') { openGroup(h.gi); return; }
  if (h && h.kind === 'row') { const i = h.pi; S.sel = h; inspectRow(h.r); flyTo({ tx: S.pos[i * 3], ty: S.pos[i * 3 + 1], tz: S.pos[i * 3 + 2], dist: Math.max(0.9, S.cam.dist * 0.45) }, 700); return; }
  S.interacted = true; const from = Object.assign({}, S.cam); const g0 = S.openGroup; S.openGroup = -2; zoomAt(0.55, x, y); S.openGroup = g0; const to = Object.assign({}, S.cam); Object.assign(S.cam, from); flyTo(to, 450);
}
function expandCol(i) {
  const nd = S.nodes[i]; S.sel = { kind: 'col', i }; S.expanded = i; S.expandedAt = performance.now(); inspectCol(i);
  const grouped = S.G && S.G.grouped; if (grouped) S.openGroup = nd.g;
  const p = grouped ? nd.wall : nd.pos, ang = grouped ? S.gnodes[nd.g].a : Math.atan2(nd.pos[2], nd.pos[0]);
  flyTo({ tx: p[0], ty: p[1] + 0.9, tz: p[2], dist: 3.4, yaw: -ang - Math.PI / 2 + Math.PI, pitch: 0.18 }, 900);
}

/* ---------- tooltip ---------- */
const tip = $('spaceTip');
function showTip(e, h) {
  const R = data();
  let html;
  if (h.kind === 'group') { const gn = S.gnodes[h.gi], g = gn.g, w = g.worst >= 0 ? R.p.cols[g.worst] : null; html = `<b>${esc(g.label)}</b><br>${g.cols.length} columns · ${g.poor} poor · ${g.fair} fair${w ? `<br>weakest: ${esc(w.name)} (${(w.score * 100).toFixed(1)})` : ''}<br><span class="tdim">pinch in or double-click to split it into columns</span>`; }
  else if (h.kind === 'col') { const c = R.p.cols[h.i]; html = `<b>${esc(c.name)}</b><br>${esc(c.typeLabel)} · score ${(c.score * 100).toFixed(1)}<br>${(c.dims.completeness * 100).toFixed(1)}% filled · ${nf0.format(c.distinct)} distinct<br><span class="tdim">double-click to open its distribution</span>`; }
  else {
    const row = R.rows[h.r]; const vals = ['x', 'y', 'z'].map(k => S.axes[k]).filter(n => n !== '__row').map(n => `${esc(n)} ${esc(String(row[R.headers.indexOf(n)] ?? '').slice(0, 24) || '(blank)')}`);
    const f = failingRulesFor(h.r);
    html = `<b>Row ${nf0.format(h.r + 1)}</b><br>${vals.join('<br>')}${f.length ? `<br><span style="color:#ff5a7a">fails ${f.length} rule${f.length > 1 ? 's' : ''}</span>` : '<br><span style="color:#3dfcb4">passes every rule</span>'}`;
  }
  tip.innerHTML = html; tip.hidden = false;
  const b = root.getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - b.left + 16, b.width - tip.offsetWidth - 8) + 'px'; tip.style.top = Math.min(e.clientY - b.top + 16, b.height - tip.offsetHeight - 8) + 'px';
}
function hideTip() { tip.hidden = true; }

/* ---------- inspector, rules, view panels ---------- */
function bsearch(a, v) { let lo = 0, hi = a.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] === v) return true; if (a[m] < v) lo = m + 1; else hi = m - 1; } return false; }
function failingRulesFor(r) { const R = data(); return R.rules.filter(x => x.status !== 'rejected' && R.results[x.id] && !R.results[x.id].error && bsearch(R.results[x.id].failRows, r)); }
function inspectNone() { $('fpInspectBody').innerHTML = '<p class="fine">Tap a point to inspect that record, or a glowing column node to see its profile. Double-click a column node to open its distribution in place.</p>'; }
function inspectRow(r) {
  const R = data(); const row = R.rows[r]; const fails = failingRulesFor(r);
  const badCols = new Set(); fails.forEach(f => f.columns.forEach(c => badCols.add(c)));
  $('fpInspectBody').innerHTML = `<div class="ihead"><span class="lbl">Record</span><b class="mono">row ${nf0.format(r + 1)}</b></div>
    ${fails.length ? `<div class="ifails">${fails.map(f => `<button type="button" class="ifail" data-rule="${esc(f.id)}"><span class="dot ${f.severity}"></span>${esc(f.name)}</button>`).join('')}</div>` : '<p class="fine" style="color:var(--good)">Passes every active rule.</p>'}
    <table class="ikv"><tbody>${R.headers.map((h, k) => `<tr class="${badCols.has(h) ? 'bad' : ''}"><td>${esc(h)}</td><td>${esc(row[k] === undefined || row[k] === '' ? '(blank)' : String(row[k]))}</td></tr>`).join('')}</tbody></table>`;
  $('fpInspectBody').querySelectorAll('.ifail').forEach(b => b.onclick = () => focusRule(b.dataset.rule));
  showPanel('fpInspect');
}
function inspectGroup(gi) {
  const R = data(); const gn = S.gnodes[gi]; if (!gn) return; const g = gn.g;
  const list = g.cols.slice().sort((a, b) => (R.p.cols[a].score === null ? 2 : R.p.cols[a].score) - (R.p.cols[b].score === null ? 2 : R.p.cols[b].score));
  $('fpInspectBody').innerHTML = `<div class="ihead"><span class="lbl">Group</span><b class="mono">${esc(g.label)}</b></div>
    <div class="istats"><div><span class="lbl">Columns</span><b>${g.cols.length}</b></div><div><span class="lbl">Poor</span><b style="color:${g.poor ? '#ff5a7a' : 'inherit'}">${g.poor}</b></div><div><span class="lbl">Fair</span><b>${g.fair}</b></div><div><span class="lbl">Mean</span><b>${g.mean === null ? 'n/a' : (g.mean * 100).toFixed(1)}</b></div></div>
    <div class="erow"><button type="button" class="mini" data-open="1">${S.openGroup === gi ? 'Open' : 'Split it open'}</button></div>
    <div class="lbl" style="margin-top:4px">Columns, weakest first</div>
    <div class="ifails">${list.map(ci => { const c = R.p.cols[ci]; return `<button type="button" class="ifail" data-col="${ci}" style="background:rgba(95,225,255,0.05);border-color:var(--line)"><span class="dot" style="background:${scoreHex(c.score)};box-shadow:0 0 6px ${scoreHex(c.score)}"></span>${esc(c.name)} <span class="mono">${c.score === null ? 'n/a' : (c.score * 100).toFixed(1)}</span></button>`; }).join('')}</div>`;
  $('fpInspectBody').querySelector('[data-open]').onclick = () => openGroup(gi);
  $('fpInspectBody').querySelectorAll('[data-col]').forEach(b => b.onclick = () => focusColumn(+b.dataset.col));
  showPanel('fpInspect');
}
function inspectCol(i) {
  const R = data(); const c = R.p.cols[i]; const pc = v => v === null || v === undefined ? 'n/a' : (v * 100).toFixed(1);
  const rules = R.rules.filter(r => r.status !== 'rejected' && r.columns.includes(c.name));
  $('fpInspectBody').innerHTML = `<div class="ihead"><span class="lbl">Column</span><b class="mono">${esc(c.name)}</b><span class="lbl" style="color:var(--cyan)">${esc(c.typeLabel)}</span></div>
    <div class="istats"><div><span class="lbl">Score</span><b>${pc(c.score)}</b></div><div><span class="lbl">Filled</span><b>${pc(c.dims.completeness)}%</b></div><div><span class="lbl">Valid</span><b>${pc(c.dims.validity)}${c.dims.validity === null ? '' : '%'}</b></div><div><span class="lbl">Distinct</span><b>${nf0.format(c.distinct)}</b></div></div>
    <div class="erow"><button type="button" class="mini" data-ax="x">Put on X</button><button type="button" class="mini" data-ax="y">Put on Y</button><button type="button" class="mini" data-ax="z">Put on Z</button><button type="button" class="mini" data-ax="color">Colour by it</button><button type="button" class="mini" data-ax="open">Open distribution</button></div>
    ${rules.length ? `<div class="lbl" style="margin-top:6px">Rules on this column</div><div class="ifails">${rules.map(f => { const x = R.results[f.id]; return `<button type="button" class="ifail" data-rule="${esc(f.id)}"><span class="dot ${f.severity}"></span>${esc(f.name)} <span class="mono" style="color:${x && x.failed ? '#ff5a7a' : '#3dfcb4'}">${x ? nf0.format(x.failed) : 0}</span></button>`; }).join('')}</div>` : ''}`;
  $('fpInspectBody').querySelectorAll('[data-ax]').forEach(b => b.onclick = () => {
    const a = b.dataset.ax;
    if (a === 'open') expandCol(i);
    else if (a === 'color') { S.colorBy = c.name; $('spColor').value = c.name; S.focusRule = null; S.dirtyColors = true; renderRulesPanel(); }
    else { S.axes[a] = c.name; $('sp' + a.toUpperCase()).value = c.name; layout(); }
  });
  $('fpInspectBody').querySelectorAll('.ifail').forEach(b => b.onclick = () => focusRule(b.dataset.rule));
  showPanel('fpInspect');
}
function focusRule(id) {
  const R = data(); const x = R.results[id]; if (!x || x.error) return;
  if (S.focusRule === id) { clearFocus(); return; }
  S.focusRule = id; S.focusSet = new Set(x.failRows); S.dirtyColors = true;
  renderRulesPanel();
  // fly to the centre of the failing points that are in view
  let n = 0, sx = 0, syy = 0, sz = 0, maxd = 0;
  for (let i = 0; i < S.n; i++) if (S.focusSet.has(S.rowsIdx[i])) { n++; sx += S.pos[i * 3]; syy += S.pos[i * 3 + 1]; sz += S.pos[i * 3 + 2]; }
  if (n) {
    sx /= n; syy /= n; sz /= n;
    for (let i = 0; i < S.n; i++) if (S.focusSet.has(S.rowsIdx[i])) maxd = Math.max(maxd, Math.hypot(S.pos[i * 3] - sx, S.pos[i * 3 + 1] - syy, S.pos[i * 3 + 2] - sz));
    flyTo({ tx: sx, ty: syy, tz: sz, dist: Math.max(1.4, Math.min(7, maxd * 2.6 + 0.8)) }, 900);
  }
  const rule = R.rules.find(r => r.id === id);
  $('spFocus').innerHTML = `<span class="dot ${rule.severity}"></span><span><b>${esc(rule.name)}</b><br>${nf0.format(x.failed)} failing rows${n < x.failed ? `, ${nf0.format(n)} shown here` : ''}. Failing rows glow red. Tap one to see why.</span><button type="button" class="mini" id="spClear">Clear</button>`;
  $('spFocus').hidden = false; $('spClear').onclick = clearFocus;
}
function clearFocus() { S.focusRule = null; S.focusSet = null; S.dirtyColors = true; $('spFocus').hidden = true; renderRulesPanel(); }
function renderRulesPanel() {
  const R = data(); if (!R) return;
  const act = R.rules.filter(r => r.status !== 'rejected' && R.results[r.id] && !R.results[r.id].error).sort((a, b) => R.results[b.id].failed - R.results[a.id].failed);
  const failing = act.filter(r => R.results[r.id].failed);
  $('fpRulesBody').innerHTML = (failing.length ? failing : act).slice(0, 60).map(r => { const x = R.results[r.id]; return `<button type="button" class="srule${S.focusRule === r.id ? ' on' : ''}" data-rule="${esc(r.id)}" aria-pressed="${S.focusRule === r.id}"><span class="dot ${r.severity}"></span><span class="sn">${esc(r.name)}</span><span class="mono sc" style="color:${x.failed ? '#ff5a7a' : '#3dfcb4'}">${nf0.format(x.failed)}</span></button>`; }).join('') || '<p class="fine">No active rules.</p>';
  $('fpRulesHint').textContent = failing.length ? `${failing.length} failing · tap to light up` : 'all passing';
  $('fpRulesBody').querySelectorAll('.srule').forEach(b => b.onclick = () => focusRule(b.dataset.rule));
}
function fillAxisSelects() {
  const R = data();
  const usable = R.p.cols.filter(c => c.base === 'number' || c.type === 'date' || (c.categorical && c.distinct <= 40));
  const opts = sel => `<option value="__row"${sel === '__row' ? ' selected' : ''}>row order</option>` + usable.map(c => `<option value="${esc(c.name)}"${c.name === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  for (const k of ['x', 'y', 'z']) { const s = $('sp' + k.toUpperCase()); s.innerHTML = opts(S.axes[k]); s.onchange = () => { S.axes[k] = s.value; layout(); S.dirtyColors = true; }; }
}
function fillColorSelect() {
  const R = data();
  const usable = R.p.cols.filter(c => c.base === 'number' || c.type === 'date' || (c.categorical && c.distinct <= 40));
  $('spColor').innerHTML = '<option value="rules">rule results</option>' + usable.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  $('spColor').value = S.colorBy;
  $('spColor').onchange = () => { S.colorBy = $('spColor').value; if (S.focusRule) clearFocus(); S.dirtyColors = true; };
}
function renderLegend(catMap, numA) {
  const R = data(); const total = R.rows.length;
  let html;
  if (S.focusRule) html = `<span><i style="background:#ff5a7a"></i>fails the rule in focus</span><span><i style="background:rgba(95,225,255,0.35)"></i>other records</span>`;
  else if (S.colorBy === 'rules') html = `<span><i style="background:#ff5a7a"></i>fails a critical rule</span><span><i style="background:#ffbe55"></i>fails another rule</span><span><i style="background:#5fe1ff"></i>passes every rule</span>`;
  else if (catMap) html = catMap.top.map((v, k) => `<span><i style="background:${CAT_COL[k]}"></i>${esc(String(v).slice(0, 20))}</span>`).join('') + '<span><i style="background:#86afc8"></i>other</span><span><i style="background:#ff5a7a"></i>blank</span>';
  else html = `<span><i style="background:linear-gradient(90deg,#2f86ff,#5fe1ff,#b48cff,#ff5a7a);width:42px"></i>${esc(numA ? numA.a.lo : '')} to ${esc(numA ? numA.a.hi : '')}</span><span><i style="background:#ff5a7a"></i>blank</span>`;
  $('spLegend').innerHTML = html;
  $('spCount').textContent = S.n < total ? `Showing ${nf0.format(S.n)} of ${nf0.format(total)} records (all failing rows first, then a random sample).` : `${nf0.format(total)} records.`;
}

/* ---------- floating panels: drag, throw, collapse ---------- */
const panels = ['fpView', 'fpRules', 'fpInspect'].map(id => ({ id, el: $(id), x: 0, y: 0, vx: 0, vy: 0, drag: null }));
let zTop = 5;
function placePanels(force) {
  const W = root.clientWidth, H = root.clientHeight, small = W < 720;
  panels.forEach((p, k) => {
    const el = p.el; el.style.width = small ? Math.min(300, W - 32) + 'px' : '';
    if (force || !p.placed) {
      p.placed = true;
      if (small) { el.classList.add('collapsed'); p.x = 16; p.y = H - 58 - (panels.length - k) * 46; }
      else { // View top-left, Rules under it, Inspector top-right
        el.classList.remove('collapsed'); const w = el.offsetWidth || 300;
        p.x = k === 2 ? W - w - 16 : 16; p.y = k === 1 ? Math.min(H - 220, 420) : 70;
        el.style.maxHeight = k === 1 ? Math.max(200, H - p.y - 70) + 'px' : '';
      }
      el.querySelector('.fcol').textContent = el.classList.contains('collapsed') ? '+' : '–'; el.querySelector('.fcol').setAttribute('aria-expanded', !el.classList.contains('collapsed'));
    }
    clampPanel(p, false); applyPanel(p);
  });
}
function clampPanel(p, bounce) {
  const W = root.clientWidth, H = root.clientHeight, w = p.el.offsetWidth, h = p.el.offsetHeight;
  const minX = 8 - w + 60, maxX = W - 60, minY = 8, maxY = H - 40;
  if (p.x < minX) { p.x = minX; if (bounce) p.vx = -p.vx * 0.45; }
  if (p.x > maxX) { p.x = maxX; if (bounce) p.vx = -p.vx * 0.45; }
  if (p.y < minY) { p.y = minY; if (bounce) p.vy = -p.vy * 0.45; }
  if (p.y > maxY) { p.y = maxY; if (bounce) p.vy = -p.vy * 0.45; }
}
function applyPanel(p) { p.el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`; }
function stepPanels(dt) {
  for (const p of panels) {
    if (p.drag || (!p.vx && !p.vy)) continue;
    p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; const f = Math.pow(0.9, dt / 16); p.vx *= f; p.vy *= f;
    if (Math.abs(p.vx) < 0.05) p.vx = 0; if (Math.abs(p.vy) < 0.05) p.vy = 0;
    clampPanel(p, true); applyPanel(p);
  }
}
panels.forEach(p => {
  const head = p.el.querySelector('.fhead');
  p.el.addEventListener('pointerdown', () => { p.el.style.zIndex = ++zTop; });
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    head.setPointerCapture(e.pointerId); p.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, samples: [], moved: 0 }; p.vx = p.vy = 0; p.el.classList.add('lifted'); e.preventDefault();
  });
  head.addEventListener('pointermove', e => {
    const d = p.drag; if (!d || d.id !== e.pointerId) return;
    const nx = d.ox + e.clientX - d.sx, ny = d.oy + e.clientY - d.sy; const now = performance.now();
    d.samples.push({ t: now, x: nx, y: ny }); while (d.samples.length > 2 && now - d.samples[0].t > 80) d.samples.shift();
    d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.sx, e.clientY - d.sy));
    p.x = nx; p.y = ny; clampPanel(p, false); applyPanel(p);
  });
  const up = e => {
    const d = p.drag; if (!d || d.id !== e.pointerId) return; p.drag = null; p.el.classList.remove('lifted');
    const s = d.samples; if (s.length > 1 && !reduced) { const dt = s[s.length - 1].t - s[0].t; if (dt > 0) { p.vx = (s[s.length - 1].x - s[0].x) / dt * 16; p.vy = (s[s.length - 1].y - s[0].y) / dt * 16; } }
    if (d.moved < 4) toggle(p);
  };
  head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  p.el.querySelector('.fcol').onclick = () => toggle(p);
});
function toggle(p) {
  p.el.classList.toggle('collapsed');
  const open = !p.el.classList.contains('collapsed');
  p.el.querySelector('.fcol').setAttribute('aria-expanded', open);
  p.el.querySelector('.fcol').textContent = open ? '–' : '+';
  if (open && root.clientWidth < 720) panels.forEach(o => { if (o !== p && !o.el.classList.contains('collapsed')) { o.el.classList.add('collapsed'); o.el.querySelector('.fcol').setAttribute('aria-expanded', false); o.el.querySelector('.fcol').textContent = '+'; } });
  const fit = () => {
    if (open) { // pull an opened panel fully on screen
      const W = root.clientWidth, H = root.clientHeight, w = p.el.offsetWidth, h = p.el.offsetHeight;
      if (p.y + h > H - 8) p.y = Math.max(8, H - h - 8);
      if (p.x + w > W - 8) p.x = Math.max(8, W - w - 8);
      if (p.x < 8) p.x = 8;
      p.vx = p.vy = 0;
    }
    clampPanel(p, false); applyPanel(p);
  };
  fit(); requestAnimationFrame(fit);
}
function showPanel(id) { const p = panels.find(x => x.id === id); if (!p) return; p.el.style.zIndex = ++zTop; if (p.el.classList.contains('collapsed') && root.clientWidth >= 720) toggle(p); else if (root.clientWidth < 720 && p.el.classList.contains('collapsed')) toggle(p); }

/* ---------- open / close ---------- */
function size() {
  const b = root.getBoundingClientRect(); S.W = Math.max(1, b.width); S.H = Math.max(1, b.height); S.dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(S.W * S.dpr); cv.height = Math.round(S.H * S.dpr); cv.style.width = S.W + 'px'; cv.style.height = S.H + 'px';
  S.F = Math.min(S.W, S.H) * 0.95;
}
let returnFocus = null;
function open(opts) {
  if (!ctx) { const e = $('errBox'); if (e) { e.textContent = 'Holo space needs canvas support, which this browser view does not offer.'; e.hidden = false; } return; }
  if (!data()) return;
  opts = opts || {};
  returnFocus = document.activeElement;
  root.hidden = false; document.documentElement.classList.add('space-open'); S.open = true;
  size(); build(); placePanels(!S.panelsPlaced); S.panelsPlaced = true;
  renderRulesPanel(); if (!S.sel) inspectNone();
  if (opts.rule) { S.focusRule = null; setTimeout(() => focusRule(opts.rule), 60); }
  if (opts.column !== undefined) setTimeout(() => expandCol(opts.column), 60);
  S.last = 0; cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(frame);
  cv.focus({ preventScroll: true });
}
function close() {
  S.open = false; cancelAnimationFrame(S.raf); root.hidden = true; document.documentElement.classList.remove('space-open'); hideTip();
  if (returnFocus && returnFocus.focus) returnFocus.focus({ preventScroll: true });
}
$('spClose').onclick = close;
$('spReset').onclick = resetView;
$('spLayout').onclick = () => placePanels(true);
$('spAuto').onclick = () => { S.auto = !S.auto; S.interacted = false; $('spAuto').setAttribute('aria-pressed', S.auto); };
$('spAuto').setAttribute('aria-pressed', S.auto);
document.addEventListener('keydown', e => {
  if (!S.open || e.key !== 'Escape') return;
  e.preventDefault();
  if (S.expanded !== null) { S.expanded = null; return; }
  if (S.openGroup !== null || (S.nearGroup !== null && S.cam.dist < 5)) { resetView(); return; }
  close();
});
addEventListener('resize', () => { if (!S.open) return; size(); placePanels(false); });
document.addEventListener('visibilitychange', () => { if (!S.open) return; if (document.hidden) cancelAnimationFrame(S.raf); else { S.last = 0; S.raf = requestAnimationFrame(frame); } });

const spSearch = window.HoloUI ? (() => { $('spSearch').dataset.base = 'Fly to a column'; return HoloUI.makeColumnSearch($('spSearch'), $('spSugg'), () => { const R = data(); return R && R.p.cols; }, i => { if (!S.key) build(); focusColumn(i); cv.focus({ preventScroll: true }); }, i => HoloUI.groupNameOf(i)); })() : null;

window.HoloSpace = {
  open, close,
  rulesChanged() { if (!data() || S.key === null) return; computeFails(); S.dirtyColors = true; if (S.open) renderRulesPanel(); },
  profileChanged() { S.key = null; if (S.open) { build(); renderRulesPanel(); inspectNone(); } },
  _S: S, _project: project, _setRot: setRot, _zoomAt: zoomAt, _panBy: panBy, _pick: pick, _focusRule: focusRule, _expandCol: expandCol, _frame: frame, _openGroup: openGroup, _focusColumn: focusColumn, _updateSplit: updateSplit
};
})();
