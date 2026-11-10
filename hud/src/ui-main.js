(function () {
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-US');
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const nfc = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const P = v => v === null || v === undefined || isNaN(v) ? '—' : (v * 100).toFixed(1) + '%';
const num = v => v === null || v === undefined || !isFinite(v) ? '—' : Math.abs(v) >= 1e7 ? nfc.format(v) : nf2.format(v);
const dstr = t => new Date(t).toISOString().slice(0, 10);
const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const band = s => s === null ? 'var(--faint)' : s >= 0.99 ? 'var(--good)' : s >= 0.95 ? 'var(--warn)' : 'var(--crit)';
const bandName = s => s === null ? 'No data' : s >= 0.99 ? 'Good' : s >= 0.95 ? 'Fair' : 'Poor';
const fileBandHex = s => s === null ? '#4f7690' : s >= DQ.SCORE.good ? '#3dfcb4' : s >= DQ.SCORE.fair ? '#ffbe55' : '#ff5a7a';
const fileBandName = s => s === null ? 'No data' : s >= DQ.SCORE.good ? 'Good' : s >= DQ.SCORE.fair ? 'Fair' : 'Poor';
const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

let state = { profile: null, sel: 0, filter: 'all', source: null, groups: null, unfold: -1, uT: 0, hoverCol: -1, geom: null };

/* ---------- tooltip ---------- */
const tip = $('tip');
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; moveTip(e); }
function moveTip(e) { const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8); tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
function hideTip() { tip.hidden = true; }
document.addEventListener('pointermove', e => { if (!tip.hidden) moveTip(e); });

/* ---------- svg helpers ---------- */
function arcPath(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function ring(value, size, stroke, color, label) {
  const r = (size - stroke) / 2 - 2, c = size / 2, circ = 2 * Math.PI * r;
  const v = value === null || isNaN(value) ? 0 : Math.max(0, Math.min(1, value));
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(95,225,255,0.13)" stroke-width="${stroke}"/>
    <circle cx="${c}" cy="${c}" r="${r + stroke / 2 + 2}" fill="none" stroke="rgba(95,225,255,0.18)" stroke-width="0.6" stroke-dasharray="1 3"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${(circ * v).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})" style="filter:drop-shadow(0 0 4px ${color})"/>
    ${label !== undefined ? `<text x="${c}" y="${c + size * 0.07}" text-anchor="middle" fill="var(--ice)" font-family="JetBrains Mono, monospace" font-size="${size * 0.22}">${label}</text>` : ''}
  </svg>`;
}

/* ---------- orb (canvas) ---------- */
const orb = (function () {
  const cv = $('orb'), ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return { start() {}, color() {} };
  let W = 0, raf = 0, t = 0, last = 0, scoreColor = '#5fe1ff';
  const nodes = []; const rnd = (function (a) { return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })(7);
  for (let i = 0; i < 46; i++) { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u); nodes.push([s * Math.cos(th), u, s * Math.sin(th), rnd()]); }
  function size() { const r = cv.getBoundingClientRect(); const d = Math.min(2, devicePixelRatio || 1); W = Math.round(r.width * d); cv.width = W; cv.height = W; }
  function proj(x, y, z, a, tilt) {
    const ca = Math.cos(a), sa = Math.sin(a); let X = x * ca + z * sa, Z = -x * sa + z * ca;
    const ct = Math.cos(tilt), st = Math.sin(tilt); const Y = y * ct - Z * st; Z = y * st + Z * ct;
    return [X, Y, Z];
  }
  function draw(now) {
    if (!W) size();
    const c = W / 2, R = W * 0.215, a = t, tilt = 0.42;
    ctx.clearRect(0, 0, W, W);
    const g = ctx.createRadialGradient(c, c, 0, c, c, R * 1.25);
    g.addColorStop(0, 'rgba(95,225,255,0.20)'); g.addColorStop(0.55, 'rgba(47,134,255,0.08)'); g.addColorStop(1, 'rgba(47,134,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, R * 1.25, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(1, W / 700);
    const seg = 56;
    const line = (fn) => {
      let prev = null;
      for (let i = 0; i <= seg; i++) {
        const p = proj(...fn(i / seg), a, tilt);
        if (prev) { ctx.strokeStyle = `rgba(95,225,255,${p[2] > 0 ? 0.42 : 0.10})`; ctx.beginPath(); ctx.moveTo(c + prev[0] * R, c + prev[1] * R); ctx.lineTo(c + p[0] * R, c + p[1] * R); ctx.stroke(); }
        prev = p;
      }
    };
    for (let k = -3; k <= 3; k++) { const lat = k * Math.PI / 8, y = Math.sin(lat), rr = Math.cos(lat); line(u => [rr * Math.cos(u * Math.PI * 2), y, rr * Math.sin(u * Math.PI * 2)]); }
    for (let k = 0; k < 10; k++) { const lon = k * Math.PI / 10; line(u => { const th = u * Math.PI * 2; return [Math.cos(th) * Math.cos(lon), Math.sin(th), Math.cos(th) * Math.sin(lon)]; }); }
    for (const n of nodes) {
      const p = proj(n[0], n[1], n[2], a, tilt); if (p[2] < -0.1) continue;
      const pulse = 0.55 + 0.45 * Math.sin(now / 600 + n[3] * 10);
      const x = c + p[0] * R, y = c + p[1] * R, s = W / 260 * (0.6 + p[2] * 0.5);
      const gg = ctx.createRadialGradient(x, y, 0, x, y, s * 4); gg.addColorStop(0, `rgba(214,244,255,${0.9 * pulse})`); gg.addColorStop(1, 'rgba(95,225,255,0)');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, s * 4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = scoreColor; ctx.globalAlpha = 0.5; ctx.lineWidth = Math.max(1, W / 500);
    ctx.beginPath(); ctx.ellipse(c, c, R * 1.18, R * 0.36, -0.18, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < 33) return; last = now; t += 0.006; draw(now);
  }
  addEventListener('resize', () => { size(); if (reduced) draw(0); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelAnimationFrame(raf); else if (!reduced) raf = requestAnimationFrame(loop); });
  return { start() { size(); if (reduced) draw(0); else raf = requestAnimationFrame(loop); }, color(c) { scoreColor = c; if (reduced) draw(0); } };
})();

/* ---------- core svg ----------
   Up to DQ.GROUP_AT columns the outer ring has one spoke per column (length = completeness).
   Wider files get arcs of related columns, a fine tick band with one tick per column, and arcs that
   unfold into spokes on tap, double-click, pinch or ctrl-scroll. */
const isGrouped = () => !!(state.groups && state.groups.grouped);
const colHex = s => s === null || s === undefined || isNaN(s) ? '#4f7690' : s >= 0.99 ? '#5fe1ff' : s >= 0.95 ? '#ffbe55' : '#ff5a7a';
const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const TWO = Math.PI * 2;
const ABBR = { ids: 'ID', dates: 'DT', amounts: 'AMT', measures: 'NUM', codes: 'CODE', flags: 'FLAG', contact: 'CONT', location: 'LOC', text: 'TXT' };
const angIn = (a, a0, a1) => { const d = (((a - a0) % TWO) + TWO) % TWO; return d <= a1 - a0 + 1e-9 ? d : -1; };

function spokeSvg(c, i, a, sw, op, flash) {
  const comp = c.dims.completeness, len = 6 + 22 * (comp || 0);
  const clr = comp >= 0.99 ? '#5fe1ff' : comp >= 0.95 ? '#ffbe55' : '#ff5a7a';
  const x0 = 200 + 152 * Math.cos(a), y0 = 200 + 152 * Math.sin(a), x1 = 200 + (152 + len) * Math.cos(a), y1 = 200 + (152 + len) * Math.sin(a);
  const xb = 200 + 180 * Math.cos(a), yb = 200 + 180 * Math.sin(a), on = i === state.sel;
  return `<g class="colbar${on ? ' sel' : ''}${flash ? ' flash' : ''}" data-i="${i}" style="opacity:${(on ? 1 : 0.78) * op}" tabindex="0" role="button" aria-label="${esc(c.name)} ${P(comp)} complete">
      <line x1="${x0}" y1="${y0}" x2="${xb}" y2="${yb}" stroke="rgba(95,225,255,0.10)" stroke-width="${sw}" />
      <line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${clr}" stroke-width="${sw}" style="filter:drop-shadow(0 0 3px ${clr})"/>
      ${on ? `<circle cx="${200 + 184 * Math.cos(a)}" cy="${200 + 184 * Math.sin(a)}" r="3" fill="#d6f4ff"/>` : ''}
    </g>`;
}

function renderCore(p, animate) {
  const svg = $('coreSvg');
  const s = p.score, n = p.cols.length, grouped = isGrouped();
  const col = fileBandHex(s);
  orb.color(col);
  $('coreBox').classList.toggle('grouped', grouped);
  let ticks = '';
  if (!grouped) for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2, r0 = i % 10 ? 193 : 187; ticks += `<line x1="${200 + r0 * Math.cos(a)}" y1="${200 + r0 * Math.sin(a)}" x2="${200 + 198 * Math.cos(a)}" y2="${200 + 198 * Math.sin(a)}" stroke="rgba(95,225,255,${i % 10 ? 0.3 : 0.75})" stroke-width="${i % 10 ? 0.8 : 1.4}"/>`; }
  let spokes = '';
  if (!grouped) {
    const sw = Math.max(1.5, Math.min(14, (2 * Math.PI * 160 / Math.max(1, n)) * 0.6));
    const flash = state.flashI !== undefined && performance.now() < state.flashUntil;
    p.cols.forEach((c, i) => { spokes += spokeSvg(c, i, -Math.PI / 2 + (i + 0.5) / n * Math.PI * 2, sw, 1, flash && state.flashI === i); });
  }
  const circ = 2 * Math.PI * 126, v = s === null ? 0 : s;
  const crit = p.issues.filter(i => i.sev === 'critical').length;
  svg.innerHTML = `
    <defs><radialGradient id="cg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="rgba(1,6,13,0.0)"/><stop offset="62%" stop-color="rgba(1,6,13,0.0)"/><stop offset="100%" stop-color="rgba(47,134,255,0.10)"/></radialGradient><radialGradient id="mid"><stop offset="0%" stop-color="rgba(1,6,13,0.78)"/><stop offset="70%" stop-color="rgba(1,6,13,0.45)"/><stop offset="100%" stop-color="rgba(1,6,13,0)"/></radialGradient></defs>
    <circle cx="200" cy="200" r="198" fill="url(#cg)"/>
    ${grouped ? '<circle cx="200" cy="200" r="182" fill="none" stroke="rgba(95,225,255,0.18)" stroke-width="0.6"/><circle cx="200" cy="200" r="199" fill="none" stroke="rgba(95,225,255,0.16)" stroke-width="0.6" stroke-dasharray="1 5"/>' : `<g class="spin">${ticks}</g>`}
    <circle cx="200" cy="200" r="148" fill="none" stroke="rgba(95,225,255,0.35)" stroke-width="0.8"/>
    ${grouped ? '<g id="ringG"></g>' : spokes}
    <g class="spin rev"><circle cx="200" cy="200" r="139" fill="none" stroke="rgba(95,225,255,0.35)" stroke-width="1" stroke-dasharray="2 6 18 6"/></g>
    <circle cx="200" cy="200" r="126" fill="none" stroke="rgba(95,225,255,0.12)" stroke-width="9"/>
    <circle id="scoreArc" cx="200" cy="200" r="126" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="butt" stroke-dasharray="${reduced || !animate ? (circ * v).toFixed(1) : 0} ${circ.toFixed(1)}" transform="rotate(-90 200 200)" style="filter:drop-shadow(0 0 7px ${col});transition:stroke-dasharray 1.2s cubic-bezier(.2,.8,.2,1)"/>
    <circle cx="200" cy="200" r="112" fill="none" stroke="rgba(95,225,255,0.25)" stroke-width="0.6" stroke-dasharray="1 4"/>
    <circle cx="200" cy="208" r="78" fill="url(#mid)"/>
    <text x="200" y="164" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-size="11" letter-spacing="3" fill="#86afc8">FILE QUALITY</text>
    <text x="200" y="222" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-weight="600" font-size="58" fill="#d6f4ff" style="filter:drop-shadow(0 0 10px ${col})">${s === null ? '—' : (s * 100).toFixed(1)}</text>
    <text x="200" y="246" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-size="12" letter-spacing="3" fill="${col}">${fileBandName(s).toUpperCase()}${crit ? ' · ' + crit + ' CRITICAL ' + (crit === 1 ? 'ISSUE' : 'ISSUES') : ''}</text>
    <text x="200" y="272" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#86afc8">${p.nRows ? P(p.cleanRows / p.nRows) + ' clean records' : ''}</text>`;
  if (!reduced && animate) requestAnimationFrame(() => requestAnimationFrame(() => { const a = $('scoreArc'); if (a) a.setAttribute('stroke-dasharray', `${(circ * v).toFixed(1)} ${circ.toFixed(1)}`); }));
  if (grouped) { drawRing(); return; }
  svg.querySelectorAll('.colbar').forEach(g => {
    const i = +g.dataset.i, c = p.cols[i];
    g.addEventListener('pointerenter', e => showTip(e, `${esc(c.name)}<br>${P(c.dims.completeness)} complete · score ${P(c.score)}`));
    g.addEventListener('pointerleave', hideTip);
    g.addEventListener('click', () => select(i, true));
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i, true); } });
  });
}
function refreshRing() { const p = state.profile; if (!p) return; if (isGrouped()) drawRing(); else renderCore(p, false); }

/* ring geometry for the grouped view: arc spans plus one angle per column */
function ringGeom() {
  const p = state.profile, G = state.groups, t = easeIO(Math.max(0, Math.min(1, state.uT)));
  const spans = DQ.ringSpans(G.groups, state.unfold, t);
  const ang = new Float64Array(p.cols.length);
  G.groups.forEach((g, gi) => {
    const s = spans[gi], w = s.a1 - s.a0, pad = Math.min(0.022, w * 0.14);
    s.p0 = s.a0 + pad; s.p1 = s.a1 - pad;
    const m = g.cols.length, span = s.p1 - s.p0;
    g.cols.forEach((ci, k) => { ang[ci] = s.p0 + (k + 0.5) / m * span; });
  });
  return { spans, ang, t };
}
function drawRing() {
  const p = state.profile, G = state.groups, el = $('ringG'); if (!p || !G || !el) return;
  const { spans, ang, t } = ringGeom(); state.geom = { spans, ang };
  const pt = (r, a) => `${(200 + r * Math.cos(a)).toFixed(2)} ${(200 + r * Math.sin(a)).toFixed(2)}`;
  const flash = state.flashI !== undefined && performance.now() < state.flashUntil;
  let arcs = '', defs = '', spk = '';
  G.groups.forEach((g, gi) => {
    const s = spans[gi], open = gi === state.unfold, op = open ? 1 - t : 1;
    const m = g.cols.length, clr = colHex(g.worstScore);
    if (op > 0.02) {
      const good = m - g.poor - g.fair - g.cols.filter(i => p.cols[i].score === null).length;
      // mix strip along the inner edge: good, fair, poor shares of the group
      let mix = '', a = s.p0; const len = s.p1 - s.p0;
      [[good, '#5fe1ff'], [g.fair, '#ffbe55'], [g.poor, '#ff5a7a']].forEach(([k, c]) => { if (!k) return; const b = a + len * k / m; mix += `<path d="${arcPath(200, 200, 155.5, a, b)}" stroke="${c}" stroke-width="3" fill="none" opacity="0.9"/>`; a = b; });
      // label: pick the longest text that fits the arc
      const mid = (s.p0 + s.p1) / 2, low = Math.sin(mid) > 0.12, rr = low ? 170.5 : 163, room = (s.p1 - s.p0) * rr - 6;
      const ab = ABBR[g.family] || g.familyShort, tag = g.short.slice(g.familyShort.length).trim();
      const cands = [`${g.short} · ${m}`, g.short, tag ? `${ab} ${tag} · ${m}` : `${ab} · ${m}`, tag ? `${ab} ${tag}` : ab, tag || ab, ab, String(m)];
      const label = cands.find(x => x.length * 5.1 <= room) || '';
      const lp = low ? `M${pt(rr, s.p1)} A${rr} ${rr} 0 ${s.p1 - s.p0 > Math.PI ? 1 : 0} 0 ${pt(rr, s.p0)}` : arcPath(200, 200, rr, s.p0, s.p1);
      defs += `<path id="gl${gi}" d="${lp}"/>`;
      const aria = `${g.label}: ${m} columns, ${g.poor} poor${g.worst >= 0 ? ', weakest ' + p.cols[g.worst].name + ' ' + P(g.worstScore) : ''}. Press Enter to unfold.`;
      arcs += `<g class="garc" data-g="${gi}" tabindex="0" role="button" aria-label="${esc(aria)}" style="opacity:${op.toFixed(3)}">
        <path d="${arcPath(200, 200, 166, s.p0, s.p1)}" stroke="rgba(95,225,255,0.07)" stroke-width="28" fill="none"/>
        <path d="${arcPath(200, 200, 166, s.p0, s.p1)}" stroke="${clr}" stroke-opacity="${g.poor ? 0.26 : 0.16}" stroke-width="22" fill="none"/>
        <path class="gfocus" d="${arcPath(200, 200, 166, s.p0, s.p1)}" stroke="${clr}" stroke-opacity="0" stroke-width="26" fill="none"/>
        ${mix}
        <path d="${arcPath(200, 200, 178.5, s.p0, s.p1)}" stroke="${clr}" stroke-width="1.6" fill="none" style="filter:drop-shadow(0 0 4px ${clr})"/>
        ${label ? `<text font-family="Chakra Petch, sans-serif" font-size="8" letter-spacing="0.5" fill="#d6f4ff" pointer-events="none"><textPath href="#gl${gi}" startOffset="50%" text-anchor="middle">${esc(label)}</textPath></text>` : ''}
      </g>`;
    }
    if (open && t > 0.02) {
      const span = s.p1 - s.p0, sw = Math.max(1.5, Math.min(10, span / m * 166 * 0.6));
      g.cols.forEach(ci => { spk += spokeSvg(p.cols[ci], ci, ang[ci], sw, t, flash && state.flashI === ci); });
    }
  });
  // tick band: one tick per column, coloured by its score; poor ones longer and glowing
  const paths = { good: '', fair: '', poor: '', none: '' };
  p.cols.forEach((c, i) => {
    const sc = c.score, k = sc === null || sc === undefined ? 'none' : sc >= 0.99 ? 'good' : sc >= 0.95 ? 'fair' : 'poor';
    const r1 = k === 'poor' ? 197 : k === 'fair' ? 193 : 190.5, a = ang[i];
    paths[k] += `M${pt(184, a)}L${pt(r1, a)}`;
  });
  const tw = Math.max(0.6, Math.min(1.6, TWO * 190 / p.cols.length * 0.45));
  let band = `<path d="${paths.none}" stroke="#4f7690" stroke-width="${tw}"/><path d="${paths.good}" stroke="rgba(95,225,255,0.55)" stroke-width="${tw}"/><path d="${paths.fair}" stroke="#ffbe55" stroke-width="${tw}"/><path d="${paths.poor}" stroke="#ff5a7a" stroke-width="${tw * 1.3}" style="filter:drop-shadow(0 0 2px #ff5a7a)"/>`;
  if (state.hoverCol >= 0 && state.hoverCol < p.cols.length) band += `<path d="M${pt(181, ang[state.hoverCol])}L${pt(201, ang[state.hoverCol])}" stroke="#d6f4ff" stroke-width="1.6"/>`;
  if (state.sel >= 0 && state.sel < p.cols.length) {
    const a = ang[state.sel], b = 0.035;
    band += `<path d="M${pt(183, a)}L${pt(199, a)}" stroke="#d6f4ff" stroke-width="2" style="filter:drop-shadow(0 0 4px #d6f4ff)"/><path d="M${pt(201, a)}L${pt(208, a - b)}L${pt(208, a + b)}Z" fill="#d6f4ff"/>`;
  }
  el.innerHTML = `<defs>${defs}</defs>${arcs}${spk}<g pointer-events="none">${band}</g>`;
}

/* ---------- unfold / fold ---------- */
let uAnim = 0;
function animateU(target, dur, done) {
  cancelAnimationFrame(uAnim);
  if (reduced) { state.uT = target; drawRing(); if (done) done(); return; }
  const from = state.uT, t0 = performance.now();
  const step = now => { const k = Math.min(1, (now - t0) / dur); state.uT = from + (target - from) * k; drawRing(); if (k < 1) uAnim = requestAnimationFrame(step); else if (done) done(); };
  uAnim = requestAnimationFrame(step);
}
function unfold(gi) {
  if (!isGrouped() || gi < 0 || gi >= state.groups.groups.length) return;
  if (state.unfold === gi) { if (state.uT < 1) animateU(1, 380); renderUnfold(); return; }
  if (state.unfold >= 0 && state.uT > 0) { animateU(0, 180, () => { state.unfold = gi; renderUnfold(); animateU(1, 420); }); return; }
  state.unfold = gi; renderUnfold(); animateU(1, 420);
}
function fold() {
  if (state.unfold < 0) return;
  animateU(0, 300, () => { state.unfold = -1; state.uT = 0; renderUnfold(); drawRing(); });
}
function renderUnfold() {
  const box = $('unfold'), p = state.profile, G = state.groups;
  if (!p || !isGrouped() || state.unfold < 0) { box.hidden = true; box.innerHTML = ''; return; }
  const g = G.groups[state.unfold];
  const bits = [`${g.cols.length} columns`]; if (g.poor) bits.push(`${g.poor} poor`); if (g.fair) bits.push(`${g.fair} fair`);
  box.innerHTML = `<div class="uh"><span class="t">${esc(g.label)}</span><span class="n">${bits.join(' · ')}</span><button type="button" class="mini" id="foldBtn">Fold</button></div>
    <div class="uchips">${g.cols.map(i => { const c = p.cols[i]; return `<button type="button" class="uchip${i === state.sel ? ' sel' : ''}" data-i="${i}" title="${esc(c.name)} · score ${P(c.score)}"><i style="background:${colHex(c.score)};box-shadow:0 0 6px ${colHex(c.score)}"></i><span>${esc(c.name)}</span></button>`; }).join('')}</div>`;
  box.hidden = false;
  $('foldBtn').onclick = fold;
  box.querySelectorAll('.uchip').forEach(b => b.onclick = () => select(+b.dataset.i, false));
}
function renderSel() {
  const p = state.profile, el = $('cSel'); if (!p || !p.cols.length) { el.innerHTML = ''; return; }
  const c = p.cols[state.sel]; if (!c) { el.innerHTML = ''; return; }
  const g = isGrouped() ? state.groups.groups[state.groups.groupOf[state.sel]] : null;
  el.innerHTML = `<span><b>${esc(c.name)}</b> · ${esc(c.typeLabel)}${g ? ' · in ' + esc(g.label) : ''}</span><span style="color:${colHex(c.score)}">score ${P(c.score)}</span><span>${P(c.dims.completeness)} filled</span><button type="button" class="mini" id="selOpen">Open column scan</button>`;
  $('selOpen').onclick = () => $('detail').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}
function flashColumn(i) {
  state.flashI = i; state.flashUntil = performance.now() + 1600;
  if (isGrouped()) { const gi = state.groups.groupOf[i]; if (state.unfold !== gi) unfold(gi); else drawRing(); }
  else refreshRing();
  setTimeout(() => { if (state.flashI === i && performance.now() >= state.flashUntil) refreshRing(); }, 1700);
}

/* pointer on the ring: svg coordinates, radius and which column tick is nearest */
function svgPoint(e) { const b = $('coreSvg').getBoundingClientRect(); const x = (e.clientX - b.left) / b.width * 400, y = (e.clientY - b.top) / b.height * 400; return { x, y, r: Math.hypot(x - 200, y - 200), a: Math.atan2(y - 200, x - 200) }; }
function groupAtAngle(a) {
  const sp = state.geom && state.geom.spans; if (!sp) return -1;
  for (let gi = 0; gi < sp.length; gi++) if (angIn(a, sp[gi].a0, sp[gi].a1) >= 0) return gi;
  return -1;
}
function colAtAngle(a) {
  const gi = groupAtAngle(a); if (gi < 0) return -1;
  const g = state.groups.groups[gi], s = state.geom.spans[gi], m = g.cols.length;
  const d = angIn(a, s.p0, s.p1 + TWO) , span = s.p1 - s.p0;
  const k = d < 0 || d > span + 0.5 ? (angIn(a, s.a0, s.p0) >= 0 ? 0 : m - 1) : Math.max(0, Math.min(m - 1, Math.floor(d / span * m)));
  return g.cols[k];
}
const inBand = pt => pt.r >= 180.5 && pt.r <= 210;
function colTip(c) { return `${esc(c.name)}<br>${esc(c.typeLabel)} · score ${P(c.score)} · ${P(c.dims.completeness)} filled`; }
function groupTip(g) {
  const p = state.profile;
  return `<b>${esc(g.label)}</b><br>${g.cols.length} columns · ${g.poor} poor · ${g.fair} fair${g.worst >= 0 ? `<br>weakest: ${esc(p.cols[g.worst].name)} (${P(g.worstScore)})` : ''}<br><span style="color:var(--faint)">tap or pinch out to unfold</span>`;
}

/* ---------- panels ---------- */
function renderTelemetry(p) {
  const keys = p.keyCandidates.length ? p.keyCandidates.join(', ') : p.cols.filter(c => c.key).map(c => c.name + (c.key === 'duplicates' ? ' (has duplicates)' : ' (has gaps)')).join(', ') || 'none found';
  $('tele').innerHTML = [
    ['Rows profiled', nf0.format(p.nRows)], ['Columns', nf0.format(p.nCols)], ['Cells', nfc.format(p.nRows * p.nCols)], ['Duplicate rows', nf0.format(p.dupRows)],
    ['Clean records', p.nRows ? P(p.cleanRows / p.nRows) : '—'], ['Scan time', p.ms < 1000 ? p.ms + ' ms' : (p.ms / 1000).toFixed(1) + ' s']
  ].map(([k, v]) => `<div><div class="lbl">${k}</div><div class="v">${v}</div></div>`).join('') + `<div style="grid-column:1/3"><div class="lbl">Likely key columns</div><div class="v small">${esc(keys)}</div></div>`;
  $('teleHint').textContent = p.sampled ? 'sampled' : 'full file';
  const notes = [];
  if (p.sampled) notes.push(`<span class="warnnote">This file has ${nf0.format(p.totalRows)} rows. The scan used a random sample of ${nf0.format(p.nRows)} rows, so counts are estimates.</span>`);
  if (state.source && state.source.kind === 'sample') notes.push('Synthetic P&amp;C claims made up for this demo, with problems planted on purpose.');
  if (!p.nRows) notes.push('This file has a header but no data rows.');
  $('teleNote').innerHTML = notes.join('<br>');
  $('teleNote').className = 'note';
}
function renderDims(p) {
  const d = [['completeness', 'Completeness'], ['validity', 'Validity'], ['uniqueness', 'Uniqueness'], ['consistency', 'Consistency']];
  $('dimgrid').innerHTML = d.map(([k, n]) => { const v = p.dims[k]; return `<div class="dim">${ring(v, 100, 7, band(v), v === null ? '—' : (v * 100).toFixed(1))}<div class="lbl">${n}</div><div class="w">${Math.round(p.weights[k] * 100)}%</div></div>`; }).join('');
}
function renderSev(p) {
  const c = { critical: 0, warning: 0, info: 0 }; p.issues.forEach(i => c[i.sev]++);
  $('sevrow').innerHTML = ['critical', 'warning', 'info'].map(s => `<span class="sev"><span class="dot ${s}"></span><b>${c[s]}</b>${s}</span>`).join('');
}
function renderIssues(p) {
  const f = state.filter, c = { all: p.issues.length, critical: 0, warning: 0, info: 0 }; p.issues.forEach(i => c[i.sev]++);
  $('filters').innerHTML = ['all', 'critical', 'warning', 'info'].map(k => `<button type="button" class="chip" data-f="${k}" aria-pressed="${f === k}">${k} ${c[k]}</button>`).join('');
  $('filters').querySelectorAll('.chip').forEach(b => b.onclick = () => { state.filter = b.dataset.f; renderIssues(p); });
  $('issHint').textContent = 'select to inspect';
  const list = p.issues.filter(i => f === 'all' || i.sev === f);
  $('issues').innerHTML = list.length ? list.map((i, k) => `<li><button type="button" class="issue ${i.sev}" data-k="${k}">
      <span class="dot ${i.sev}"></span><span class="t">${esc(i.text)}</span><span class="c">${i.col !== null ? esc(i.col) : 'file'}</span>
      <span class="d">${i.dim || 'scan'}${i.col === null && i.samples && i.samples.length ? ' · select to show rows' : ''}</span>
      <span class="ex" hidden></span></button></li>`).join('') : '<li class="empty">No issues in this view.</li>';
  $('issues').querySelectorAll('.issue').forEach(b => b.onclick = () => {
    const i = list[+b.dataset.k];
    if (i.col !== null) { select(i.colIdx, true); return; }
    const ex = b.querySelector('.ex');
    if (i.samples && i.samples.length) { ex.innerHTML = i.samples.map(s => `<span>${s.row !== undefined ? 'row ' + nf0.format(s.row + 1) + ' · ' : ''}${esc(s.v)}</span>`).join(''); ex.hidden = !ex.hidden; }
  });
}
function spark(c) {
  const w = 200, h = 28;
  let bins = null;
  if (c.num) bins = c.num.hist.bins; else if (c.date) bins = c.date.hist.bins;
  if (bins) {
    const mx = Math.max(1, ...bins), bw = w / bins.length;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${bins.map((b, i) => `<rect x="${i * bw + 0.5}" y="${h - Math.max(b ? 1.5 : 0, b / mx * h)}" width="${Math.max(1, bw - 1.5)}" height="${Math.max(b ? 1.5 : 0, b / mx * h)}" fill="rgba(95,225,255,0.75)"/>`).join('')}</svg>`;
  }
  const top = c.top.slice(0, 8); if (!top.length) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><text x="0" y="18" fill="#4f7690" font-size="11" font-family="JetBrains Mono, monospace">no values</text></svg>`;
  const mx = top[0].c, bw = w / 8;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${top.map((t, i) => `<rect x="${i * bw + 1}" y="${h - Math.max(2, t.c / mx * h)}" width="${bw - 3}" height="${Math.max(2, t.c / mx * h)}" fill="rgba(47,134,255,0.8)"/>`).join('')}</svg>`;
}
function renderMatrix(p) {
  $('matrix').innerHTML = p.cols.map((c, i) => {
    const nIss = c.issues.filter(x => x.sev !== 'info').length;
    return `<button type="button" class="card${i === state.sel ? ' sel' : ''}" data-i="${i}" aria-pressed="${i === state.sel}">
      <span class="ring">${ring(c.score, 52, 5, band(c.score), c.score === null ? '—' : Math.round(c.score * 100))}</span>
      <span class="nm" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="ty">${esc(c.typeLabel)}${c.key ? ' · key' : ''}</span>
      ${spark(c)}
      <span class="meta"><span>${P(c.dims.completeness)} filled</span><span>${nfc.format(c.distinct)} distinct</span><span style="color:${nIss ? 'var(--warn)' : 'var(--faint)'}">${nIss} ${nIss === 1 ? 'issue' : 'issues'}</span></span>
    </button>`;
  }).join('') || '<p class="empty">No columns found.</p>';
  $('matrix').querySelectorAll('.card').forEach(b => b.onclick = () => select(+b.dataset.i, true));
}

/* ---------- detail ---------- */
function histSvg(c) {
  const isDate = !!c.date, H = isDate ? c.date.hist : c.num.hist;
  const W = 620, h = 200, padL = 8, padR = 8, top = 14, base = 160;
  const bins = H.bins, extra = H.above > 0 ? 1 : 0, nb = bins.length + extra;
  const mx = Math.max(1, ...bins, H.above || 0);
  const bw = (W - padL - padR) / nb;
  const lab = v => isDate ? dstr(v) : num(v);
  let bars = '';
  bins.forEach((b, i) => {
    const bh = b / mx * (base - top), x = padL + i * bw;
    const lo = H.lo + (H.hi - H.lo) * i / bins.length, hi = H.lo + (H.hi - H.lo) * (i + 1) / bins.length;
    bars += `<rect class="hb" x="${x + 1}" y="${base - bh}" width="${Math.max(1, bw - 2)}" height="${Math.max(0, bh)}" fill="url(#hg)" data-t="${esc(lab(lo) + ' to ' + lab(hi))}: ${nf0.format(b)}"/>`;
  });
  if (extra) { const bh = H.above / mx * (base - top), x = padL + bins.length * bw; bars += `<rect class="hb" x="${x + 1}" y="${base - bh}" width="${Math.max(1, bw - 2)}" height="${bh}" fill="#ff5a7a" style="filter:drop-shadow(0 0 4px #ff5a7a)" data-t="${nf0.format(H.above)} values above ${esc(lab(H.hi))}"/><text x="${x + bw / 2}" y="${base - bh - 4}" text-anchor="middle" font-size="10" fill="#ff5a7a" font-family="JetBrains Mono, monospace">+${nfc.format(H.above)}</text>`; }
  let marks = '';
  if (!isDate && c.num) {
    const xm = v => padL + (v - H.lo) / (H.hi - H.lo || 1) * bins.length * bw;
    if (c.num.median >= H.lo && c.num.median <= H.hi) marks += `<line x1="${xm(c.num.median)}" x2="${xm(c.num.median)}" y1="${top - 6}" y2="${base}" stroke="#d6f4ff" stroke-dasharray="3 3" stroke-width="1"/><text x="${Math.min(W - 60, xm(c.num.median) + 4)}" y="${top + 2}" font-size="10" fill="#d6f4ff" font-family="JetBrains Mono, monospace">median ${esc(num(c.num.median))}</text>`;
    if (H.lo < 0 && H.hi > 0) marks += `<line x1="${xm(0)}" x2="${xm(0)}" y1="${top}" y2="${base}" stroke="#ff5a7a" stroke-width="1" opacity="0.7"/>`;
  }
  let grid = ''; for (let k = 0; k <= 4; k++) { const y = top + (base - top) * k / 4; grid += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="rgba(95,225,255,0.08)"/>`; }
  return `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="Distribution of ${esc(c.name)}">
    <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9af0ff"/><stop offset="1" stop-color="rgba(47,134,255,0.35)"/></linearGradient></defs>
    ${grid}<g style="filter:drop-shadow(0 0 4px rgba(95,225,255,0.55))">${bars}</g>${marks}
    <line x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}" stroke="rgba(95,225,255,0.6)"/>
    <text x="${padL}" y="${base + 18}" font-size="11" fill="#86afc8" font-family="JetBrains Mono, monospace">${esc(lab(H.lo))}</text>
    <text x="${padL + bins.length * bw}" y="${base + 18}" text-anchor="end" font-size="11" fill="#86afc8" font-family="JetBrains Mono, monospace">${esc(lab(H.hi))}</text>
    <text x="${padL}" y="${base + 34}" font-size="10" fill="#4f7690" font-family="JetBrains Mono, monospace">${H.below ? nf0.format(H.below) + ' below range · ' : ''}peak bin ${nf0.format(Math.max(...bins))}</text>
  </svg>`;
}
function completenessDonut(c) {
  const parts = [['Filled', c.present, '#5fe1ff'], ['Missing', c.missing, '#ff5a7a'], ['Whitespace only', c.blank, '#b48cff'], ['Placeholder', c.placeholder, '#ffbe55']];
  const tot = Math.max(1, c.n), R = 54, cx = 70, cy = 70; let a = -Math.PI / 2, segs = '';
  for (const [, v, col] of parts) { if (!v) continue; const a1 = a + v / tot * Math.PI * 2 - (v === tot ? 0.0001 : 0); segs += `<path d="${arcPath(cx, cy, R, a, a1)}" fill="none" stroke="${col}" stroke-width="12" style="filter:drop-shadow(0 0 4px ${col})"/>`; a = a1; }
  return `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 140 140" width="132" height="132" role="img" aria-label="${P(c.dims.completeness)} complete">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(95,225,255,0.1)" stroke-width="12"/>${segs}
    <circle cx="${cx}" cy="${cy}" r="${R - 14}" fill="none" stroke="rgba(95,225,255,0.25)" stroke-dasharray="1 3"/>
    <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="19" fill="#d6f4ff" font-family="JetBrains Mono, monospace">${(c.dims.completeness * 100).toFixed(1)}</text>
    <text x="${cx}" y="${cy + 22}" text-anchor="middle" font-size="8.5" letter-spacing="2" fill="#86afc8" font-family="Chakra Petch, sans-serif">% FILLED</text></svg>
    <div class="legend" style="flex:1;min-width:120px">${parts.map(([n, v, col]) => `<div><span><i style="background:${col}"></i>${n}</span><span class="mono">${nf0.format(v)}</span></div>`).join('')}</div></div>`;
}
function sampleTable(samples) {
  if (!samples || !samples.length) return '';
  return `<div class="samples"><table><tbody>${samples.map(s => `<tr><td>${s.row !== undefined ? 'row ' + nf0.format(s.row + 1) : ''}</td><td>${esc(s.v)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderDetail(p) {
  const c = p.cols[state.sel];
  if (!c) { $('detailBody').innerHTML = '<p class="empty">Load a file to inspect its columns.</p>'; return; }
  const dims = [['Completeness', c.dims.completeness], ['Validity', c.dims.validity], ['Uniqueness', c.dims.uniqueness], ['Consistency', c.dims.consistency]];
  const stats = [['Rows', nf0.format(c.n)], ['Filled', nf0.format(c.present)], ['Distinct', nf0.format(c.distinct)], ['Distinct share', P(c.distinctRatio)]];
  if (c.num) stats.push(['Min', num(c.num.min)], ['Max', num(c.num.max)], ['Mean', num(c.num.mean)], ['Median', num(c.num.median)], ['Std dev', num(c.num.std)], ['Q1 / Q3', num(c.num.q1) + ' / ' + num(c.num.q3)], ['Zeros', nf0.format(c.num.zeros)], ['Sum', num(c.num.sum)]);
  if (c.date) stats.push(['Earliest', dstr(c.date.min)], ['Latest', dstr(c.date.max)], ['Span', nf0.format(Math.round((c.date.max - c.date.min) / 86400000)) + ' days']);
  if (c.lens) stats.push(['Length min / max', c.lens.min + ' / ' + c.lens.max], ['Average length', c.lens.avg.toFixed(1)]);
  const mx = c.top.length ? c.top[0].c : 1;
  const topHtml = c.top.length ? `<div class="topv">${c.top.slice(0, 10).map(t => `<div class="r"><span class="k" title="${esc(t.v)}">${esc(t.v)}</span><span class="n">${nf0.format(t.c)} · ${P(t.c / Math.max(1, c.present))}</span><span class="bar"><i style="width:${(t.c / mx * 100).toFixed(1)}%"></i></span></div>`).join('')}</div>` : '<p class="empty">No values.</p>';
  const unique = c.distinct === c.present && c.present > 0;

  // checks: passes and issues
  const checks = [];
  if (c.rule) checks.push({ sev: c.invalidCount ? (c.invalidCount / Math.max(1, c.present) > 0.05 ? 'critical' : 'warning') : 'good', text: `Rule: ${c.rule}. ${P(c.dims.validity)} of filled values pass.` });
  if (c.formats.length) checks.push({ sev: c.formats.length > 1 ? 'warning' : 'good', text: 'Formats in use: ' + c.formats.slice(0, 5).map(f => `${f.f} (${nf0.format(f.c)})`).join(', ') });
  if (c.num) checks.push({ sev: (c.num.outLow + c.num.outHigh) ? 'warning' : 'good', text: `Outlier fences (${c.num.outlierMethod}): ${num(c.num.fenceLo)} to ${num(c.num.fenceHi)}. ${nf0.format(c.num.outLow + c.num.outHigh)} values outside.` });
  if (c.key) checks.push({ sev: c.dupValues ? 'critical' : 'good', text: `Treated as a key column: ${P(c.dims.uniqueness)} of filled values are unique.`, samples: c.dupSamples.map(d => ({ v: d.v + '  ×' + d.c })) });
  else if (unique && c.present >= 10) checks.push({ sev: 'info', text: 'Every filled value is unique.' });
  if (c.topShapes.length && c.type === 'identifier') checks.push({ sev: 'info', text: 'Value patterns (A letter, 9 digit): ' + c.topShapes.slice(0, 4).map(s => `${s.s} ${P(s.share)}`).join(', ') });
  if (c.variants.length) checks.push({ sev: 'warning', text: 'Case or spacing variants: ' + c.variants.slice(0, 4).map(g => g.forms.map(f => `"${f.v}" ${nf0.format(f.c)}`).join(' / ')).join('; ') });
  for (const i of c.issues) if (!/fail the|Formats in use|formats in use|spelled with different/.test(i.text) || i.samples) checks.push({ sev: i.sev, text: i.text, samples: i.samples });
  const seen = new Set();
  const checksHtml = checks.filter(k => { const key = k.text; if (seen.has(key)) return false; seen.add(key); return true; }).map(k => `<div class="check ${k.sev}"><span class="dot ${k.sev}"></span><span>${esc(k.text)}</span>${sampleTable(k.samples)}</div>`).join('');

  const chart = (c.num && c.num.hist.bins.some(b => b)) || (c.date && c.date.hist.bins.some(b => b)) ? histSvg(c) : null;
  $('detailBody').innerHTML = `
    <div class="dhead">${ring(c.score, 70, 6, band(c.score), c.score === null ? '—' : (c.score * 100).toFixed(0))}
      <div style="min-width:0"><h3>${esc(c.name)}</h3><div class="lbl" style="color:var(--cyan)">${esc(c.typeLabel)}${c.key ? ' · likely key' : ''}${c.categorical ? ' · categorical' : ''} · column ${c.idx + 1} of ${p.nCols}</div></div></div>
    <div class="dgrid">
      <div class="sub"><h4>Completeness</h4>${completenessDonut(c)}
        <h4 style="margin-top:16px">Dimension scores</h4>
        <div class="dims4">${dims.map(([n, v]) => `<div class="row"><span>${n}</span><span class="bar"><i style="width:${v === null ? 0 : (v * 100).toFixed(1)}%;background:${band(v)};box-shadow:0 0 8px ${band(v)}"></i></span><span>${v === null ? 'n/a' : (v * 100).toFixed(1)}</span></div>`).join('')}</div>
      </div>
      <div class="sub wide"><h4>${chart ? (c.date ? 'Distribution over time' : 'Value distribution') : 'Top values'}</h4>${chart || topHtml}
        <div class="stats">${stats.map(([k, v]) => `<div><div class="lbl">${k}</div><div class="v">${v}</div></div>`).join('')}</div></div>
      <div class="sub"><h4>${chart ? 'Top values' : 'Value lengths'}</h4>${chart ? topHtml : (c.lens ? `<div class="stats" style="margin-top:0"><div><div class="lbl">Shortest</div><div class="v">${c.lens.min}</div></div><div><div class="lbl">Longest</div><div class="v">${c.lens.max}</div></div><div><div class="lbl">Average</div><div class="v">${c.lens.avg.toFixed(1)}</div></div></div>` : '<p class="empty">No values.</p>')}</div>
    </div>
    <div class="checks">${checksHtml || '<div class="check good"><span class="dot good"></span><span>No problems found in this column.</span></div>'}</div>`;
  $('detailBody').querySelectorAll('.hb').forEach(r => { r.addEventListener('pointerenter', e => showTip(e, esc(r.dataset.t).replace(/&amp;/g, '&'))); r.addEventListener('pointerleave', hideTip); });
}

function select(i, scroll) {
  const p = state.profile; if (!p) return;
  state.sel = i; refreshRing(); renderDetail(p); renderSel();
  $('matrix').querySelectorAll('.card').forEach(b => { const on = +b.dataset.i === i; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on); });
  $('unfold').querySelectorAll('.uchip').forEach(b => b.classList.toggle('sel', +b.dataset.i === i));
  if (scroll) $('detail').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

function renderAll(p) {
  state.profile = p;
  const worst = p.cols.reduce((b, c, i) => (c.score !== null && (b < 0 || c.score < p.cols[b].score) ? i : b), -1);
  state.sel = worst < 0 ? 0 : worst;
  state.filter = 'all';
  state.groups = DQ.columnGroups(p.cols); state.unfold = -1; state.uT = 0; state.hoverCol = -1; state.flashI = undefined;
  cancelAnimationFrame(uAnim);
  $('ringHelp').textContent = isGrouped()
    ? `${p.cols.length} columns, so the outer ring shows ${state.groups.groups.length} arcs of related columns, each lit by its weakest column. Tap, double-click or pinch out on an arc to unfold its columns into spokes; pinch in, ctrl-scroll back or press Esc to fold. The thin outer band has one tick per column (red is poor); drag along it to scrub. Select the core to open the holo space.`
    : 'Outer ring: one spoke per column, length shows completeness. Select a spoke to inspect that column, double-click it to fly into it, or select the core to open the holo space.';
  renderTelemetry(p); renderDims(p); renderSev(p); renderIssues(p); renderCore(p, true); renderMatrix(p); renderDetail(p); renderBreak(p);
  renderUnfold(); renderSel(); coreSearch.refresh(); $('colSearch').value = '';
}
function renderBreak(p) {
  const b = p.scoreParts, el = $('scoreBreak');
  if (!b || b.dimScore === null || p.score === null) { el.textContent = ''; return; }
  const parts = [`dimensions ${(b.dimScore * 100).toFixed(1)}`];
  if (b.cleanRate !== null) parts.push(`clean records ${(b.cleanRate * 100).toFixed(1)}`);
  let t = parts.length > 1 ? `Half ${parts[0]}, half ${parts[1]}` : parts[0];
  if (b.critPenalty) t += `, minus ${(b.critPenalty * 100).toFixed(0)} for ${b.nCritical} critical ${b.nCritical === 1 ? 'issue' : 'issues'}`;
  el.textContent = t + ` = ${(p.score * 100).toFixed(1)}`;
}

/* ---------- file chip ---------- */
function renderChip(src, sheets) {
  const parts = [];
  if (src.kind === 'sample') parts.push('<span class="tag sample">Sample data</span>');
  parts.push(`<span class="name">${esc(src.name)}</span>`);
  parts.push(`<span class="meta">${esc(src.fmt)}${src.size ? ' · ' + fmtBytes(src.size) : ''}</span>`);
  if (sheets && sheets.length > 1) parts.push(`<label class="meta">Sheet <select class="sheet" id="sheetSel">${sheets.map((s, i) => `<option value="${i}"${i === src.sheet ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`);
  $('filechip').innerHTML = parts.join('');
  const ss = $('sheetSel'); if (ss) ss.onchange = () => loadExcelSheet(+ss.value);
}

/* ---------- profiling runner (web worker with main-thread fallback) ---------- */
let worker = null, workerFailed = false;
function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    const src = $('engine-src').textContent + '\nself.onmessage=function(e){try{self.postMessage({ok:true,p:DQ.profileTable(e.data)})}catch(err){self.postMessage({ok:false,e:String(err&&err.message||err)})}};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch (e) { workerFailed = true; worker = null; }
  return worker;
}
function profileAsync(input) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const fallback = () => setTimeout(() => { try { resolve(DQ.profileTable(input)); } catch (e) { reject(e); } }, 30);
    if (!w) return fallback();
    w.onmessage = e => e.data.ok ? resolve(e.data.p) : reject(new Error(e.data.e));
    w.onerror = ev => { ev.preventDefault && ev.preventDefault(); workerFailed = true; worker = null; fallback(); };
    try { w.postMessage(input); } catch (e) { workerFailed = true; worker = null; fallback(); }
  });
}

function setBusy(on, label) {
  $('scanning').hidden = !on; $('scanning').firstChild.textContent = label || 'SCANNING';
  document.body.style.cursor = on ? 'progress' : '';
}
function showError(msg) { $('errBox').textContent = msg; $('errBox').hidden = !msg; }

async function runProfile(headers, rows, src, extra) {
  setBusy(true, 'PROFILING');
  try {
    const p = await profileAsync(Object.assign({ headers, rows, now: Date.now() }, extra || {}));
    state.source = src; renderAll(p); showError('');
    window.__holoLast = { p, rows, src };
    if (window.HoloRules) HoloRules.load(p, rows, src);
    if (window.HoloOps) HoloOps.fileLoaded(p, rows, src);
    if (window.HoloSpace) HoloSpace.profileChanged();
    $('spaceBtn').disabled = false;
  } catch (e) { showError('The scan failed: ' + (e.message || e) + '. Try saving the file as UTF-8 CSV and dropping it again.'); }
  finally { setBusy(false); }
}

/* ---------- readers ---------- */
const MAX = DQ.MAX_ROWS;
function readCSV(fileOrText, src) {
  return new Promise((resolve, reject) => {
    if (typeof Papa === 'undefined') { reject(new Error('The CSV reader did not load. Check your connection and reload the page.')); return; }
    let headers = null; const res = new DQ.Reservoir(MAX);
    Papa.parse(fileOrText, {
      skipEmptyLines: true, worker: false,
      chunk: (r) => { for (const row of r.data) { if (!headers) { headers = row; continue; } res.push(row); } },
      complete: () => resolve({ headers: headers || [], rows: res.rows, total: res.seen }),
      error: (e) => reject(e)
    });
  }).then(({ headers, rows, total }) => {
    if (!headers.length) throw new Error('This file is empty.');
    return runProfile(headers, rows, src, { sampled: total > rows.length, totalRows: total });
  });
}
let xlsxWb = null;
function loadScript(url) { return new Promise((ok, no) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + url.split('/').slice(-3).join('/'))); document.head.appendChild(s); }); }
async function readExcel(file, src) {
  if (typeof XLSX === 'undefined') await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const buf = await file.arrayBuffer();
  xlsxWb = XLSX.read(buf, { type: 'array', cellNF: true });
  let first = xlsxWb.SheetNames.findIndex(n => { const ws = xlsxWb.Sheets[n]; return ws && ws['!ref'] && ws['!ref'] !== 'A1'; });
  src.sheet = first < 0 ? 0 : first; state.pendingSrc = src;
  return loadExcelSheet(src.sheet);
}
// Read cells directly so date cells become exact calendar dates (no time-zone shift) and errors become placeholders.
function sheetRows(ws) {
  if (!ws || !ws['!ref']) return [];
  const rg = XLSX.utils.decode_range(ws['!ref']), out = [], p2 = n => String(n).padStart(2, '0');
  for (let r = rg.s.r; r <= rg.e.r; r++) {
    const row = []; let any = false;
    for (let c = rg.s.c; c <= rg.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]; let v = '';
      if (cell) {
        if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
          const d = XLSX.SSF.parse_date_code(cell.v);
          if (d) { const S = Math.floor(d.S || 0); v = d.y + '-' + p2(d.m) + '-' + p2(d.d) + (d.H || d.M || S ? ' ' + p2(d.H) + ':' + p2(d.M) + ':' + p2(S) : ''); }
        } else if (cell.t === 'e') v = cell.w || '#N/A';
        else if (cell.t === 'b') v = cell.v ? 'true' : 'false';
        else if (cell.t === 'd') v = DQ.cellToString(cell.v, true);
        else v = cell.v === undefined || cell.v === null ? '' : String(cell.v);
      }
      if (v !== '') any = true;
      row.push(v);
    }
    if (any) out.push(row);
  }
  return out;
}
function loadExcelSheet(i) {
  const src = Object.assign({}, state.pendingSrc || state.source, { sheet: i });
  state.pendingSrc = src;
  const name = xlsxWb.SheetNames[i];
  const aoa = sheetRows(xlsxWb.Sheets[name]);
  renderChip(src, xlsxWb.SheetNames);
  if (!aoa.length) { showError(`Sheet "${name}" is empty. Pick another sheet.`); return; }
  const res = new DQ.Reservoir(MAX); for (let r = 1; r < aoa.length; r++) res.push(aoa[r]);
  return runProfile(aoa[0], res.rows, src, { sampled: res.seen > res.rows.length, totalRows: res.seen });
}
const HYP = 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.5/src/index.js';
const HYPC = 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/src/';
async function readParquet(file, src) {
  setBusy(true, 'DECODING');
  let hp;
  try { hp = await import(HYP); } catch (e) { throw new Error('The Parquet decoder could not load from cdn.jsdelivr.net. Your file was not sent anywhere. Try CSV or Excel instead.'); }
  const buf = await file.arrayBuffer();
  const meta = hp.parquetMetadata(buf);
  const names = meta.schema.slice(1).filter(s => !s.num_children).map(s => s.name);
  let rows;
  try { rows = await hp.parquetReadObjects({ file: buf }); }
  catch (e) {
    if (!/compression|codec/i.test(e.message)) throw e;
    // load the extra codecs (no WebAssembly; Snappy stays on the built-in decoder)
    const [gz, br, lz, zs] = await Promise.allSettled([import(HYPC + 'gzip.js'), import(HYPC + 'brotli.js'), import(HYPC + 'lz4.js'), import('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/esm/index.mjs')]);
    const compressors = {};
    if (gz.status === 'fulfilled') compressors.GZIP = (input, len) => gz.value.gunzip(input, new Uint8Array(len));
    if (br.status === 'fulfilled') compressors.BROTLI = br.value.decompressBrotli;
    if (lz.status === 'fulfilled') { compressors.LZ4 = lz.value.decompressLz4; compressors.LZ4_RAW = lz.value.decompressLz4Raw; }
    if (zs.status === 'fulfilled') compressors.ZSTD = input => zs.value.decompress(input);
    try { rows = await hp.parquetReadObjects({ file: buf, compressors }); }
    catch (e2) { throw new Error('This Parquet file uses a compression codec the browser decoder could not load (' + e2.message + '). Snappy and uncompressed Parquet work.'); }
  }
  const res = new DQ.Reservoir(MAX);
  for (const r of rows) res.push(names.map(n => DQ.cellToString(r[n])));
  return runProfile(names, res.rows, src, { sampled: res.seen > res.rows.length, totalRows: res.seen });
}

async function handleFile(file) {
  if (!file) return;
  showError('');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const src = { kind: 'file', name: file.name, size: file.size, fmt: '' };
  try {
    if (['csv', 'tsv', 'txt'].includes(ext)) { src.fmt = ext.toUpperCase(); renderChip(src); setBusy(true, 'READING'); await readCSV(file, src); }
    else if (['xlsx', 'xlsm', 'xls'].includes(ext)) { src.fmt = 'Excel'; renderChip(src); setBusy(true, 'READING'); await readExcel(file, src); }
    else if (ext === 'parquet') { src.fmt = 'Parquet'; renderChip(src); await readParquet(file, src); }
    else showError(`"${file.name}" isn't a supported type. Use a .csv, .tsv, .txt, .xlsx, .xls or .parquet file.`);
  } catch (e) { showError(e.message || String(e)); if (state.source) renderChip(state.source, state.source.fmt === 'Excel' && xlsxWb ? xlsxWb.SheetNames : null); }
  finally { setBusy(false); }
}
function loadSample() {
  const csv = DQ.sampleClaimsCSV(20261110);
  const src = { kind: 'sample', name: 'pc_claims_sample.csv', size: csv.length, fmt: 'CSV · 2,007 rows, made up' };
  renderChip(src); showError('');
  return readCSV(csv, src).catch(e => showError(e.message || String(e)));
}

/* ---------- wiring ---------- */
$('openBtn').onclick = () => $('fileInput').click();
$('drop').onclick = () => $('fileInput').click();
$('drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } };
$('fileInput').onchange = e => { handleFile(e.target.files[0]); e.target.value = ''; };
$('sampleBtn').onclick = loadSample;
$('spaceBtn').onclick = () => window.HoloSpace && HoloSpace.open({});
$('coreBox').addEventListener('click', e => {
  if (e.target.closest && (e.target.closest('.colbar') || e.target.closest('.garc'))) return;
  if (isGrouped() && (performance.now() < quietUntil || inBand(svgPoint(e)))) return;
  if (window.HoloSpace && state.profile) HoloSpace.open({});
});
$('coreSvg').addEventListener('dblclick', e => { const g = e.target.closest && e.target.closest('.colbar'); if (g && window.HoloSpace && state.profile) HoloSpace.open({ column: +g.dataset.i }); });
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragover', e => { e.preventDefault(); });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });
$('copyBtn').onclick = async () => {
  const p = state.profile; if (!p) return;
  const src = state.source || { name: 'file' };
  const lines = [`Data quality scan: ${src.name}`, `Score ${p.score === null ? 'n/a' : (p.score * 100).toFixed(1)} (${fileBandName(p.score)}) · ${nf0.format(p.nRows)} rows · ${p.nCols} columns${p.sampled ? ' (sampled)' : ''}`,
    `Completeness ${P(p.dims.completeness)} · Validity ${P(p.dims.validity)} · Uniqueness ${P(p.dims.uniqueness)} · Consistency ${P(p.dims.consistency)}`, ''];
  for (const i of p.issues) lines.push(`[${i.sev.toUpperCase()}] ${i.col !== null ? i.col + ': ' : ''}${i.text}`);
  const text = lines.join('\n');
  try { await navigator.clipboard.writeText(text); $('copied').hidden = false; setTimeout(() => $('copied').hidden = true, 1800); $('copyFallback').hidden = true; }
  catch (e) { const ta = $('copyFallback'); ta.value = text; ta.hidden = false; ta.focus(); ta.select(); }
};

/* ---------- column search (shared with the holo space) ---------- */
function makeColumnSearch(input, list, getCols, onPick, groupLabel) {
  let items = [], act = -1;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); act = -1; input.removeAttribute('aria-activedescendant'); };
  const mark = (name, q) => { const k = name.toLowerCase().indexOf(q); return k < 0 ? esc(name) : esc(name.slice(0, k)) + '<b>' + esc(name.slice(k, k + q.length)) + '</b>' + esc(name.slice(k + q.length)); };
  function update() {
    const cols = getCols(); const q = input.value.trim().toLowerCase();
    if (!cols || !q) { close(); items = []; return; }
    const qs = q.replace(/[\s_\-.]+/g, '');
    const scored = [];
    cols.forEach((c, i) => {
      const n = String(c.name).toLowerCase(), ns = n.replace(/[\s_\-.]+/g, '');
      let s = -1;
      if (n === q) s = 0; else if (n.startsWith(q)) s = 1; else if (new RegExp('(^|[^a-z0-9])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(n)) s = 2; else if (n.includes(q)) s = 3; else if (qs && ns.includes(qs)) s = 4;
      if (s >= 0) scored.push([s, n.length, i]);
    });
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    items = scored.slice(0, 8).map(x => x[2]);
    const id = list.id;
    list.innerHTML = items.length ? items.map((i, k) => { const c = cols[i]; return `<li role="option" id="${id}-${k}" data-i="${i}" aria-selected="${k === act}"><i class="dot" style="background:${colHex(c.score)};box-shadow:0 0 6px ${colHex(c.score)}"></i><span class="nm">${mark(c.name, q)}</span><span class="g">${esc(groupLabel ? groupLabel(i) : c.typeLabel)}</span></li>`; }).join('') + (scored.length > 8 ? `<li class="none" aria-disabled="true">${scored.length - 8} more, keep typing</li>` : '')
      : '<li class="none" aria-disabled="true">No column matches</li>';
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
    list.querySelectorAll('li[data-i]').forEach(li => { li.onpointerdown = e => { e.preventDefault(); choose(+li.dataset.i); }; });
  }
  function setAct(k) {
    act = k; list.querySelectorAll('li[data-i]').forEach((li, j) => li.setAttribute('aria-selected', j === act));
    if (act >= 0) { input.setAttribute('aria-activedescendant', list.id + '-' + act); const li = list.querySelector(`#${list.id}-${act}`); if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
  }
  function choose(i) { const cols = getCols(); if (!cols || !cols[i]) return; input.value = cols[i].name; close(); onPick(i); }
  input.addEventListener('input', () => { act = -1; update(); if (items.length) setAct(0); });
  input.addEventListener('focus', () => { if (input.value.trim()) update(); });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) update(); if (items.length) setAct((act + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) setAct((act - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list.hidden) update(); if (items.length) choose(items[Math.max(0, act)]); }
    else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } }
  });
  return { refresh() { input.placeholder = input.dataset.base + (getCols() ? ` (${getCols().length} columns)` : ''); }, close };
}
const groupNameOf = i => isGrouped() ? state.groups.groups[state.groups.groupOf[i]].label : state.profile.cols[i].typeLabel;
$('colSearch').dataset.base = 'Find a column';
const coreSearch = makeColumnSearch($('colSearch'), $('colSugg'), () => state.profile && state.profile.cols, i => { select(i, false); flashColumn(i); }, groupNameOf);
window.HoloUI = { makeColumnSearch, columnGroups: () => state.groups, groupNameOf, colHex };

/* ---------- ring gestures (grouped view) ---------- */
const svgEl = $('coreSvg'), boxEl = $('coreBox');
let quietUntil = 0, scrub = null, hoverRaf = 0;
const quiet = () => { quietUntil = performance.now() + 400; };
function setHover(i) { if (state.hoverCol === i) return; state.hoverCol = i; cancelAnimationFrame(hoverRaf); hoverRaf = requestAnimationFrame(drawRing); }
function unfoldAt(e) {
  const pt = svgPoint(e);
  if (pt.r < 120) { const gi = state.groups.groupOf[state.sel]; if (gi >= 0) unfold(gi); return; }
  const gi = groupAtAngle(pt.a); if (gi >= 0) unfold(gi);
}
svgEl.addEventListener('pointermove', e => {
  if (!isGrouped()) return;
  const p = state.profile, pt = svgPoint(e);
  if (scrub && scrub.id === e.pointerId) {
    const i = colAtAngle(pt.a); if (i >= 0 && i !== state.sel) { state.sel = i; state.hoverCol = i; scrub.moved = true; drawRing(); renderSel(); }
    showTip(e, colTip(p.cols[state.sel])); return;
  }
  if (e.pointerType !== 'mouse') return;
  const sp = e.target.closest && e.target.closest('.colbar');
  if (sp) { setHover(+sp.dataset.i); showTip(e, colTip(p.cols[+sp.dataset.i])); return; }
  if (inBand(pt)) { const i = colAtAngle(pt.a); if (i >= 0) { setHover(i); showTip(e, colTip(p.cols[i]) + '<br><span style="color:var(--faint)">drag along the band to scrub</span>'); return; } }
  setHover(-1);
  const ga = e.target.closest && e.target.closest('.garc');
  if (ga) { showTip(e, groupTip(state.groups.groups[+ga.dataset.g])); return; }
  hideTip();
});
svgEl.addEventListener('pointerleave', () => { if (!isGrouped() || scrub) return; setHover(-1); hideTip(); });
svgEl.addEventListener('pointerdown', e => {
  if (!isGrouped() || !e.isPrimary || e.button > 0) return;
  const pt = svgPoint(e); if (!inBand(pt)) return;
  const i = colAtAngle(pt.a); if (i < 0) return;
  scrub = { id: e.pointerId, moved: false, start: i };
  try { svgEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  state.sel = i; state.hoverCol = i; drawRing(); renderSel(); showTip(e, colTip(state.profile.cols[i]));
  e.preventDefault();
});
const endScrub = e => {
  if (!scrub || scrub.id !== e.pointerId) return;
  scrub = null; quiet(); state.hoverCol = -1; hideTip(); select(state.sel, false);
};
svgEl.addEventListener('pointerup', endScrub); svgEl.addEventListener('pointercancel', endScrub);
svgEl.addEventListener('click', e => {
  if (!isGrouped()) return;
  const sp = e.target.closest && e.target.closest('.colbar');
  if (sp) { select(+sp.dataset.i, false); return; }
  const ga = e.target.closest && e.target.closest('.garc');
  if (ga) unfold(+ga.dataset.g);
});
svgEl.addEventListener('keydown', e => {
  if (!isGrouped()) return;
  const ga = e.target.closest && e.target.closest('.garc'), sp = e.target.closest && e.target.closest('.colbar');
  if ((e.key === 'Enter' || e.key === ' ') && ga) { e.preventDefault(); unfold(+ga.dataset.g); }
  else if ((e.key === 'Enter' || e.key === ' ') && sp) { e.preventDefault(); select(+sp.dataset.i, false); }
  else if (e.key === 'Escape' && state.unfold >= 0) { e.preventDefault(); fold(); }
});
// pinch: two fingers on touch screens, ctrl+scroll (trackpad pinch) on desktops, gesture events on Safari
const touches = new Map(); let pinch = null, wheelAcc = 0, wheelT = 0;
boxEl.addEventListener('pointerdown', e => {
  if (!isGrouped() || e.pointerType !== 'touch') return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { const [a, b] = Array.from(touches.values()); pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), done: false }; if (scrub) { scrub = null; hideTip(); } }
});
boxEl.addEventListener('pointermove', e => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || pinch.done || touches.size < 2) return;
  const [a, b] = Array.from(touches.values()), d = Math.hypot(a.x - b.x, a.y - b.y), k = d / Math.max(1, pinch.d0);
  if (k > 1.25) { pinch.done = true; quiet(); unfoldAt({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }); }
  else if (k < 0.8) { pinch.done = true; quiet(); fold(); }
});
const dropTouch = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
boxEl.addEventListener('pointerup', dropTouch); boxEl.addEventListener('pointercancel', dropTouch);
boxEl.addEventListener('wheel', e => {
  if (!isGrouped() || !e.ctrlKey) return;
  e.preventDefault();
  const now = performance.now(); if (now - wheelT > 350) wheelAcc = 0; wheelT = now;
  wheelAcc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (wheelAcc < -24) { wheelAcc = -1e9; quiet(); unfoldAt(e); }
  else if (wheelAcc > 24) { wheelAcc = 1e9; quiet(); fold(); }
}, { passive: false });
let gScale = 1;
boxEl.addEventListener('gesturestart', e => { if (!isGrouped()) return; e.preventDefault(); gScale = 1; });
boxEl.addEventListener('gesturechange', e => {
  if (!isGrouped()) return; e.preventDefault();
  if (gScale === 0) return;
  if (e.scale > 1.2) { gScale = 0; quiet(); unfoldAt(e); } else if (e.scale < 0.83) { gScale = 0; quiet(); fold(); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !isGrouped() || state.unfold < 0) return;
  if (document.documentElement.classList.contains('space-open')) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, select, .reditor')) return;
  fold();
});

orb.start();
loadSample();
})();
