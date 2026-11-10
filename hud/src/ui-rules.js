/* Rule console: suggested + custom rules, run on the loaded file, JSON/SQL export. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-US');
const P = v => v === null || v === undefined || isNaN(v) ? '—' : v === 1 ? '100%' : v === 0 ? '0%' : (v * 100).toFixed(1) + '%';
const SEVS = DQR.SEVERITIES;
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const fileBand = s => s === null || s === undefined ? 'var(--faint)' : s >= DQ.SCORE.good ? 'var(--good)' : s >= DQ.SCORE.fair ? 'var(--warn)' : 'var(--crit)';
const fileBandName = s => s === null || s === undefined ? 'No rules' : s >= DQ.SCORE.good ? 'Good' : s >= DQ.SCORE.fair ? 'Fair' : 'Poor';

const R = {
  p: null, rows: null, headers: [], src: null,
  rules: [], results: {}, score: null, nextId: 1,
  cache: new Map(), filter: 'all', editing: null, open: new Set(), restored: false
};

function ring(value, size, stroke, color, label, sub) {
  const r = (size - stroke) / 2 - 4, c = size / 2, circ = 2 * Math.PI * r;
  const v = value === null || value === undefined || isNaN(value) ? 0 : Math.max(0, Math.min(1, value));
  let ticks = '';
  for (let i = 0; i < 60; i++) { const a = i / 60 * Math.PI * 2; const r0 = r + stroke / 2 + 3, r1 = r0 + (i % 5 ? 2 : 5); ticks += `<line x1="${(c + r0 * Math.cos(a)).toFixed(1)}" y1="${(c + r0 * Math.sin(a)).toFixed(1)}" x2="${(c + r1 * Math.cos(a)).toFixed(1)}" y2="${(c + r1 * Math.sin(a)).toFixed(1)}" stroke="rgba(95,225,255,${i % 5 ? 0.25 : 0.6})" stroke-width="1"/>`; }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" style="overflow:visible">
    ${ticks}
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(95,225,255,0.13)" stroke-width="${stroke}"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${(circ * v).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${c} ${c})" style="filter:drop-shadow(0 0 6px ${color})"/>
    <text x="${c}" y="${c + size * 0.06}" text-anchor="middle" fill="var(--ice)" font-family="Chakra Petch, sans-serif" font-weight="600" font-size="${size * 0.22}">${label}</text>
    ${sub ? `<text x="${c}" y="${c + size * 0.2}" text-anchor="middle" fill="${color}" font-family="Chakra Petch, sans-serif" font-size="${size * 0.075}" letter-spacing="2">${sub}</text>` : ''}
  </svg>`;
}

/* ---------- storage (per-viewer convenience) ---------- */
function sigOf(headers) { let h = 5381; const s = headers.join('\u0001'); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return 'holo.rules.v1.' + (h >>> 0).toString(36) + '.' + headers.length; }
function saveLocal() { try { localStorage.setItem(sigOf(R.headers), JSON.stringify({ rules: R.rules, nextId: R.nextId, saved: Date.now() })); } catch (e) { /* storage unavailable */ } }
function loadLocal() { try { const t = localStorage.getItem(sigOf(R.headers)); if (!t) return null; const d = JSON.parse(t); return d && Array.isArray(d.rules) ? d : null; } catch (e) { return null; } }
function clearLocal() { try { localStorage.removeItem(sigOf(R.headers)); } catch (e) { /* ignore */ } }

/* ---------- lifecycle ---------- */
function load(p, rows, src) {
  R.p = p; R.rows = rows; R.headers = p.headers; R.src = src; R.cache = new Map(); R.open = new Set(); R.editing = null;
  const saved = loadLocal();
  if (saved) { R.rules = saved.rules; R.nextId = saved.nextId || R.rules.length + 1; R.restored = true; }
  else { R.rules = DQR.suggestRules(p, { rows, headers: p.headers }); R.nextId = R.rules.length + 1; R.restored = false; }
  closeEditor(); $('sqlBox').hidden = true; $('jsonBox').hidden = true;
  run();
}
function newId() { let id; do { id = 'R' + String(R.nextId++).padStart(3, '0'); } while (R.rules.some(r => r.id === id)); return id; }
function run() {
  if (!R.rows) return;
  const t0 = performance.now();
  R.results = DQR.runRules(R.rules, { headers: R.headers, rows: R.rows, now: Date.now() }, R.cache);
  R.score = DQR.scoreRules(R.rules, R.results, R.rows.length);
  R.ms = performance.now() - t0;
  render();
  if (window.HoloSpace) HoloSpace.rulesChanged();
}
function changed() { saveLocal(); R.restored = false; run(); if (window.HoloOps) HoloOps.rulesChanged(); }

/* ---------- render ---------- */
function render() {
  const s = R.score;
  $('rScore').innerHTML = ring(s ? s.score : null, 150, 9, fileBand(s && s.score), s && s.score !== null ? (s.score * 100).toFixed(1) : '—', fileBandName(s && s.score).toUpperCase()) + '<div class="lbl" style="text-align:center">Rules score</div>';
  const nAll = R.rules.length, nAcc = R.rules.filter(r => r.status === 'accepted').length, nSug = R.rules.filter(r => r.status === 'suggested').length, nRej = R.rules.filter(r => r.status === 'rejected').length;
  $('rulesHint').textContent = `${nAll} rules · ${nAcc} accepted · ${nSug} to review`;
  const dimNames = { completeness: 'Completeness', validity: 'Validity', uniqueness: 'Uniqueness', consistency: 'Consistency' };
  const dims = s ? Object.keys(dimNames).filter(d => s.dims[d]).map(d => `<div class="row"><span>${dimNames[d]}</span><span class="bar"><i style="width:${(s.dims[d].rate * 100).toFixed(1)}%;background:${fileBand(s.dims[d].rate)}"></i></span><span>${(s.dims[d].rate * 100).toFixed(1)}</span></div>`).join('') : '';
  $('rKpis').innerHTML = !s ? '' : `
    <div class="tele">
      <div><div class="lbl">Rules in play</div><div class="v">${nf0.format(s.activeRules)}</div></div>
      <div><div class="lbl">Rules passing</div><div class="v">${nf0.format(s.passingRules)}</div></div>
      <div><div class="lbl">Records passing all</div><div class="v">${P(s.rowsPassAll)}</div></div>
      <div><div class="lbl">Critical rules failing</div><div class="v" style="color:${s.failingCritical ? 'var(--crit)' : 'var(--good)'}">${s.failingCritical}</div></div>
    </div>
    <div class="sevbar" aria-label="Failing rules by severity">${SEVS.map(k => `<span class="sevseg ${k}"><span class="dot ${k}"></span>${SEV_LABEL[k]} <b class="mono">${s.bySev[k].failing}/${s.bySev[k].rules}</b></span>`).join('')}</div>
    <div class="dims4" style="margin-top:10px">${dims}</div>`;
  const notes = [];
  if (R.restored) notes.push('Restored the rules you set up earlier in this browser for files with these columns.');
  if (nSug) notes.push(`${nSug} suggested rule${nSug > 1 ? 's are' : ' is'} counted until you accept or reject ${nSug > 1 ? 'them' : 'it'}. Rejected rules are left out of the score and the exports.`);
  if (nRej && !nSug) notes.push(`${nRej} rejected rule${nRej > 1 ? 's' : ''} left out of the score and exports.`);
  if (R.p && R.p.sampled) notes.push(`Rules ran on the ${nf0.format(R.rows.length)}-row sample, so counts are estimates for the full file.`);
  if (R.ms > 400) notes.push(`Rules ran in ${(R.ms / 1000).toFixed(1)} s.`);
  $('rNote').textContent = notes.join(' ');

  const counts = { all: nAll, failing: 0, suggested: nSug, accepted: nAcc, rejected: nRej, custom: 0 };
  for (const r of R.rules) { const x = R.results[r.id]; if (r.status !== 'rejected' && x && (x.failed || x.error)) counts.failing++; if (r.origin === 'custom') counts.custom++; }
  const names = { all: 'All', failing: 'Failing', suggested: 'To review', accepted: 'Accepted', rejected: 'Rejected', custom: 'Custom' };
  $('rFilters').innerHTML = Object.keys(names).map(k => `<button type="button" class="chip" data-f="${k}" aria-pressed="${R.filter === k}">${names[k]} ${counts[k]}</button>`).join('');
  $('rFilters').querySelectorAll('.chip').forEach(b => b.onclick = () => { R.filter = b.dataset.f; render(); });

  const stRank = { suggested: 0, accepted: 0, rejected: 1 }, svRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const list = R.rules.filter(r => {
    const x = R.results[r.id];
    if (R.filter === 'failing') return r.status !== 'rejected' && x && (x.failed || x.error);
    if (R.filter === 'custom') return r.origin === 'custom';
    if (R.filter !== 'all') return r.status === R.filter;
    return true;
  }).sort((a, b) => stRank[a.status] - stRank[b.status] || svRank[a.severity] - svRank[b.severity] || ((R.results[b.id] || {}).failed || 0) - ((R.results[a.id] || {}).failed || 0) || a.id.localeCompare(b.id));
  $('rList').innerHTML = list.length ? list.map(ruleHtml).join('') : '<li class="empty">No rules in this view.</li>';
}

function ruleHtml(r) {
  const x = R.results[r.id] || {};
  const bad = x.error ? 'var(--crit)' : x.failed ? (r.severity === 'critical' ? 'var(--crit)' : 'var(--warn)') : 'var(--good)';
  const rate = x.passRate;
  const stLabel = { suggested: 'Suggested', accepted: 'Accepted', rejected: 'Rejected' }[r.status];
  const res = x.error ? `<div class="rcount" style="color:var(--crit)">${esc(x.error)}</div>`
    : `<div class="rpct mono" style="color:${bad}">${x.checked ? P(rate) : 'n/a'}</div><span class="bar"><i style="width:${x.checked ? (rate * 100).toFixed(1) : 0}%;background:${bad};box-shadow:0 0 8px ${bad}"></i></span><div class="rcount mono">${x.checked ? `${nf0.format(x.failed)} of ${nf0.format(x.checked)} fail` : 'no rows to check'}</div>`;
  const open = R.open.has(r.id);
  const fails = open && x.samples && x.samples.length ? `<div class="rfail"><div class="samples"><table><thead><tr><th>Row</th>${x.samples[0].values.map(v => `<th>${esc(v.c)}</th>`).join('')}${x.samples.some(s => s.note) ? '<th></th>' : ''}</tr></thead><tbody>${x.samples.map(s => `<tr><td>${nf0.format(s.row + 1)}</td>${s.values.map(v => `<td>${esc(v.v === '' ? '(blank)' : v.v)}</td>`).join('')}${s.note ? `<td>${esc(s.note)}</td>` : ''}</tr>`).join('')}</tbody></table></div>${x.failed > x.samples.length ? `<div class="fine">First ${x.samples.length} of ${nf0.format(x.failed)} failing rows. Row numbers count data rows, excluding the header.</div>` : ''}</div>` : '';
  const scope = x.outOfScope ? ` · ${nf0.format(x.outOfScope)} rows outside the condition` : '';
  const skipped = x.skippedNull ? ` · ${nf0.format(x.skippedNull)} blank rows skipped` : '';
  return `<li class="rule ${r.severity} st-${r.status}" data-id="${esc(r.id)}">
    <div class="rmain">
      <span class="sevtag ${r.severity}">${SEV_LABEL[r.severity]}</span>
      <div class="rtext">
        <div class="rname">${esc(r.name)} <span class="stag ${r.status}">${stLabel}${r.origin === 'custom' ? ' · custom' : ''}</span></div>
        <div class="rdef mono">${esc(r.id)} · ${esc(DQR.TYPES[r.type] ? DQR.TYPES[r.type].label : r.type)} · ${esc(DQR.describe(r))}</div>
        ${r.description || r.reason ? `<div class="rdesc">${esc(r.description || '')}${r.reason ? ` <span class="why">${esc(r.reason)}</span>` : ''}<span class="why">${scope}${skipped}</span></div>` : ''}
      </div>
      <div class="rres">${res}</div>
    </div>
    <div class="ract">
      ${r.status !== 'accepted' ? `<button type="button" class="mini good" data-a="accept">Accept</button>` : ''}
      ${r.status !== 'rejected' ? `<button type="button" class="mini" data-a="reject">Reject</button>` : ''}
      <button type="button" class="mini" data-a="edit">Edit</button>
      ${x.failed ? `<button type="button" class="mini" data-a="rows" aria-expanded="${open}">${open ? 'Hide' : 'Show'} failing rows</button><button type="button" class="mini" data-a="space">Explore in holo space</button>` : ''}
      ${r.origin === 'custom' ? `<button type="button" class="mini danger" data-a="delete">Delete</button>` : ''}
    </div>
    ${fails}
  </li>`;
}

$('rList').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const li = b.closest('.rule'); const r = R.rules.find(x => x.id === li.dataset.id); if (!r) return;
  const a = b.dataset.a;
  if (a === 'accept') { r.status = 'accepted'; changed(); }
  else if (a === 'reject') { r.status = 'rejected'; R.open.delete(r.id); changed(); }
  else if (a === 'delete') { R.rules = R.rules.filter(x => x !== r); changed(); }
  else if (a === 'edit') openEditor(r);
  else if (a === 'rows') { if (R.open.has(r.id)) R.open.delete(r.id); else R.open.add(r.id); render(); }
  else if (a === 'space' && window.HoloSpace) HoloSpace.open({ rule: r.id });
});

/* ---------- editor ---------- */
const ED = id => $('ed-' + id);
function colOptions(sel, none) {
  return (none ? '<option value="">— none —</option>' : '') + R.headers.map(h => `<option value="${esc(h)}"${h === sel ? ' selected' : ''}>${esc(h)}</option>`).join('');
}
function colType(name) { const c = R.p && R.p.cols.find(c => c.name === name); return c || null; }
function openEditor(rule) {
  if (!R.p) return;
  R.editing = rule ? rule.id : null;
  const r = rule || { type: 'not_null', columns: [R.headers[0]], params: {}, severity: 'medium', name: '', description: '' };
  const p = r.params || {};
  $('edTitle').textContent = rule ? `Edit rule ${rule.id}` : 'New rule';
  ED('name').value = rule ? r.name : '';
  ED('desc').value = r.description || '';
  ED('type').value = r.type;
  ED('col1').innerHTML = colOptions(r.columns[0]);
  ED('col2').innerHTML = colOptions(r.columns[1] || '', r.type !== 'compare');
  ED('col3').innerHTML = colOptions(r.columns[2] || '', true);
  ED('op').value = p.op || '>=';
  ED('kind').value = p.kind || (colType(r.columns[0]) && colType(r.columns[0]).base === 'number' ? 'number' : 'date');
  ED('format').value = p.format || 'email';
  ED('regex').value = p.regex || '';
  ED('icase').checked = (p.flags || '').includes('i');
  ED('values').value = (p.values || []).join('\n');
  ED('vcase').checked = p.caseSensitive !== false;
  ED('min').value = p.min === undefined || p.min === null ? '' : p.min;
  ED('max').value = p.max === undefined || p.max === null ? '' : p.max;
  ED('sev').value = r.severity;
  ED('when').checked = !!r.when;
  ED('wcol').innerHTML = colOptions(r.when ? r.when.column : '');
  ED('wvals').value = r.when ? r.when.values.join(', ') : '';
  if (r.type === 'unique' && r.columns.length > 3) { $('edWide').hidden = false; $('edWide').textContent = `This rule checks all ${r.columns.length} columns together. Changing the columns here replaces that set.`; } else $('edWide').hidden = true;
  R.editWide = r.type === 'unique' && r.columns.length > 3 ? r.columns.slice() : null;
  R.editBlanks = !!p.blanksMatch;
  $('rEditor').hidden = false; syncEditor(); preview();
  $('rEditor').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  ED('name').focus({ preventScroll: true });
}
function closeEditor() { $('rEditor').hidden = true; R.editing = null; $('ed-err').textContent = ''; }
function syncEditor() {
  const t = ED('type').value;
  $('rEditor').querySelectorAll('[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(t); });
  $('ed-format-regex').hidden = !(t === 'format' && ED('format').value === 'regex');
  $('ed-col2-label').textContent = t === 'compare' ? 'Compared with' : 'Second column (optional)';
  $('ed-col1-label').textContent = t === 'compare' ? 'Column' : t === 'unique' ? 'First column' : 'Column';
  $('ed-wrow').hidden = !ED('when').checked;
  const hint = ED('kind').value === 'date' ? 'YYYY-MM-DD or "today"' : 'a number';
  ED('min').placeholder = hint; ED('max').placeholder = hint;
}
function readEditor() {
  const t = ED('type').value;
  const cols = [ED('col1').value];
  const params = {};
  if (t === 'unique') { if (R.editWide) cols.splice(0, 1, ...R.editWide); else { if (ED('col2').value) cols.push(ED('col2').value); if (ED('col3').value) cols.push(ED('col3').value); } if (R.editBlanks) params.blanksMatch = true; }
  if (t === 'compare') { cols.push(ED('col2').value); params.op = ED('op').value; params.kind = ED('kind').value; }
  if (t === 'format') { params.format = ED('format').value; if (params.format === 'regex') { params.regex = ED('regex').value; params.flags = ED('icase').checked ? 'i' : ''; } }
  if (t === 'allowed_values') { params.values = ED('values').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); params.caseSensitive = ED('vcase').checked; }
  if (t === 'range') {
    params.kind = ED('kind').value;
    const conv = v => { v = v.trim(); if (v === '') return undefined; if (params.kind === 'number') { const n = Number(v.replace(/[,$]/g, '')); return isFinite(n) ? n : v; } return v; };
    const mn = conv(ED('min').value), mx = conv(ED('max').value);
    if (mn !== undefined) params.min = mn; if (mx !== undefined) params.max = mx;
  }
  const rule = { type: t, columns: cols.filter(Boolean), params, severity: ED('sev').value, description: ED('desc').value.trim() };
  if (ED('when').checked) rule.when = { column: ED('wcol').value, values: ED('wvals').value.split(',').map(s => s.trim()).filter(Boolean) };
  rule.name = ED('name').value.trim() || cap(DQR.describe(rule));
  return rule;
}
const cap = s => s;
function preview() {
  if ($('rEditor').hidden) return;
  const rule = Object.assign({ id: 'preview' }, readEditor());
  const errs = DQR.checkRule(rule, R.headers);
  if (errs.length) { $('ed-preview').innerHTML = ''; $('ed-err').textContent = errs[0]; return; }
  $('ed-err').textContent = '';
  const x = DQR.runRule(rule, { headers: R.headers, rows: R.rows, now: Date.now() });
  $('ed-preview').innerHTML = `<span class="lbl">Preview</span> <span class="mono">${esc(cap(DQR.describe(rule)))}</span><br><b class="mono" style="color:${x.failed ? 'var(--warn)' : 'var(--good)'}">${nf0.format(x.failed)}</b> of ${nf0.format(x.checked)} checked rows fail${x.checked ? ` (${P(x.failed / x.checked)})` : ''}${x.skippedNull ? `, ${nf0.format(x.skippedNull)} blank rows skipped` : ''}${x.outOfScope ? `, ${nf0.format(x.outOfScope)} outside the condition` : ''}.`;
}
let pvTimer = 0;
$('rEditor').addEventListener('input', () => { syncEditor(); clearTimeout(pvTimer); pvTimer = setTimeout(preview, 160); });
$('rEditor').addEventListener('change', () => { syncEditor(); preview(); });
ED('type').addEventListener('change', () => {
  const t = ED('type').value;
  R.editWide = null; R.editBlanks = false; $('edWide').hidden = true;
  if (t === 'compare' && !ED('col2').value) { const other = R.headers.find(h => h !== ED('col1').value) || ''; ED('col2').innerHTML = colOptions(other); }
  else if (t !== 'compare') ED('col2').innerHTML = colOptions(ED('col2').value, true);
  const c = colType(ED('col1').value); if (c) ED('kind').value = c.base === 'number' ? 'number' : 'date';
  syncEditor(); preview();
});
ED('col1').addEventListener('change', () => { const c = colType(ED('col1').value); if (c && (ED('type').value === 'range' || ED('type').value === 'compare')) ED('kind').value = c.base === 'number' ? 'number' : 'date'; });
$('ed-fill').onclick = () => {
  const c = colType(ED('col1').value); if (!c) return;
  ED('values').value = c.top.map(t => t.v).join('\n'); preview();
};
$('rEditor').addEventListener('submit', e => {
  e.preventDefault();
  const rule = readEditor();
  const errs = DQR.checkRule(rule, R.headers);
  if (errs.length) { $('ed-err').textContent = errs[0]; return; }
  if (R.editing) {
    const old = R.rules.find(r => r.id === R.editing);
    Object.assign(old, rule); if (!rule.when) delete old.when;
    if (old.status === 'suggested') old.status = 'accepted';
    delete old.reason;
  } else R.rules.push(Object.assign({ id: newId(), status: 'accepted', origin: 'custom' }, rule));
  closeEditor(); R.filter = R.filter === 'rejected' ? 'all' : R.filter; changed();
});
$('ed-cancel').onclick = closeEditor;

/* ---------- toolbar ---------- */
$('rNew').onclick = () => openEditor(null);
$('rAcceptAll').onclick = () => { let k = 0; for (const r of R.rules) if (r.status === 'suggested') { r.status = 'accepted'; k++; } if (k) changed(); };
$('rReset').onclick = () => {
  if ($('rReset').dataset.armed !== '1') { $('rReset').dataset.armed = '1'; $('rReset').textContent = 'Tap again to reset'; setTimeout(() => { $('rReset').dataset.armed = ''; $('rReset').textContent = 'Reset to suggestions'; }, 3500); return; }
  $('rReset').dataset.armed = ''; $('rReset').textContent = 'Reset to suggestions';
  clearLocal(); R.rules = DQR.suggestRules(R.p, { rows: R.rows, headers: R.headers }); R.nextId = R.rules.length + 1; R.cache = new Map(); R.restored = false; R.open = new Set(); closeEditor(); run();
};
$('rSpace').onclick = () => window.HoloSpace && HoloSpace.open({});

let downloads = null;
if (window.claude && typeof window.claude.use === 'function') window.claude.use('downloads').then(d => { downloads = d; }).catch(() => {});
async function offerFile(filename, data, box, ta, msgEl) {
  if (downloads) {
    try { await downloads.save({ filename, data }); msgEl.textContent = 'Saved ' + filename + '.'; return; }
    catch (e) { if (e && e.code === 'declined') { msgEl.textContent = 'Save cancelled.'; return; } }
  }
  box.hidden = false; ta.value = data; msgEl.textContent = 'Saving files is not available here. Copy the text below instead.';
}
function baseName() { return (R.src && R.src.name ? R.src.name : 'rules').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_'); }
$('rExport').onclick = () => {
  const text = DQR.exportJSON(R.rules, { source: R.src && R.src.name, headers: R.headers });
  $('sqlBox').hidden = true;
  $('jsonText').value = text; $('jsonBox').hidden = false; $('jsonMsg').textContent = `${R.rules.length} rules, including suggested and rejected ones with their status.`;
  offerFile(baseName() + '_rules.json', text, $('jsonBox'), $('jsonText'), $('jsonMsg'));
};
$('jsonCopy').onclick = () => copyText($('jsonText'), $('jsonMsg'));
$('jsonClose').onclick = () => { $('jsonBox').hidden = true; };
$('rImport').onclick = () => $('rImportFile').click();
$('rImportFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const { rules, skipped } = DQR.importJSON(await f.text());
    let added = 0, replaced = 0, missing = 0;
    for (const r of rules) {
      if (r.id && R.rules.some(x => x.id === r.id)) { const i = R.rules.findIndex(x => x.id === r.id); R.rules[i] = r; replaced++; }
      else { r.id = r.id && !R.rules.some(x => x.id === r.id) ? r.id : newId(); R.rules.push(r); added++; }
      if (r.columns.some(c => R.headers.indexOf(c) < 0)) missing++;
    }
    changed();
    $('rNote').textContent = `Imported ${f.name}: ${added} rules added, ${replaced} replaced${missing ? `, ${missing} name columns that are not in this file and are shown with an error` : ''}${skipped.length ? `, ${skipped.length} entries skipped because their rule type is unknown` : ''}.`;
  } catch (err) { $('rNote').textContent = 'Import failed: ' + (err.message || err); }
};
function defaultTable() { return baseName().toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1'); }
function renderSQL() { $('sqlText').value = DQR.exportSQL(R.rules, { table: $('sqlTable').value, source: R.src && R.src.name, headers: R.headers }); }
$('rSQL').onclick = () => { $('jsonBox').hidden = true; if (!$('sqlTable').value) $('sqlTable').value = defaultTable(); renderSQL(); $('sqlBox').hidden = false; $('sqlMsg').textContent = ''; };
$('sqlTable').addEventListener('input', renderSQL);
$('sqlCopy').onclick = () => copyText($('sqlText'), $('sqlMsg'));
$('sqlSave').onclick = () => offerFile(baseName() + '_rules_snowflake.sql.txt', $('sqlText').value, $('sqlBox'), $('sqlText'), $('sqlMsg'));
$('sqlClose').onclick = () => { $('sqlBox').hidden = true; };
async function copyText(ta, msg) {
  try { await navigator.clipboard.writeText(ta.value); msg.textContent = 'Copied.'; }
  catch (e) { ta.focus(); ta.select(); msg.textContent = 'Press Ctrl+C or Cmd+C to copy the selected text.'; }
}

// Swap in a saved rule set (from a monitored dataset) and keep it for files with these columns.
function replaceRules(rules) {
  if (!R.rows || !Array.isArray(rules)) return false;
  R.rules = JSON.parse(JSON.stringify(rules)); R.cache = new Map(); R.open = new Set(); closeEditor();
  const nums = R.rules.map(r => parseInt(String(r.id).replace(/\D+/g, ''), 10)).filter(n => isFinite(n));
  R.nextId = (nums.length ? Math.max(...nums) : R.rules.length) + 1;
  changed(); return true;
}
window.HoloRules = { load, get state() { return R; }, run, open: openEditor, replace: replaceRules };
if (window.__holoLast) load(window.__holoLast.p, window.__holoLast.rows, window.__holoLast.src);
})();
