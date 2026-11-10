/* Data sources (hosted app only): Snowflake and S3 connections, and which dataset runs against which table or file.
   Secrets go straight to the server, which encrypts them; they are never read back to the page. */
(function () {
'use strict';
if (!window.HoloServer) return;
const SRV = window.HoloServer;
const $ = id => document.getElementById(id);
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = { snowflake: 'Snowflake', s3: 'S3 / CSV' };
const TABLE_RE = /^("[^"]{1,255}"|[A-Za-z_][A-Za-z0-9_$]{0,254})(\.("[^"]{1,255}"|[A-Za-z_][A-Za-z0-9_$]{0,254})){0,2}$/;

const X = { sources: null, sched: {}, loading: false, adding: null, busy: {}, msg: {}, err: '', confirmDel: null };
const ops = () => window.HoloOps;
const rerender = () => { const o = ops(); if (o && o.state && o.state.view === 'schedules') o.renderAll(); };

async function refresh() {
  if (X.loading) return; X.loading = true;
  try {
    const [s, sc] = await Promise.all([SRV.sources.list(), SRV.schedules()]);
    X.sources = s.sources || []; X.sched = {};
    for (const r of sc.schedules || []) X.sched[r.dataset_id] = r;
    X.err = '';
  } catch (e) { X.err = 'Could not load data sources: ' + (e.message || e); if (!X.sources) X.sources = []; }
  finally { X.loading = false; rerender(); }
}

function callout() {
  return `<div class="callout"><b>How schedules run.</b> A dataset connected to a Snowflake table or an S3 file runs on the server at its scheduled time, even when this page is closed (the server checks every 15 minutes). A dataset without a source runs when you drop a matching file here, and missed slots are caught up as one run. Times are in ${esc(SRV.tz)}.</div>`;
}

function when(t) { const o = ops(); return t ? (o && o.when ? o.when(new Date(t).getTime()) : new Date(t).toLocaleString()) : '—'; }

function cardRow(d) {
  if (X.sources === null) { refresh(); return '<div class="srcrow fine">Loading data sources…</div>'; }
  const cur = (d.source && d.source.id) || '', obj = (d.source && d.source.object) || '';
  const src = X.sources.find(s => s.id === cur);
  const sc = X.sched[d.id];
  const k = src ? src.kind : null;
  const ph = k === 's3' ? 'path/to/file.csv or folder/ for the newest file' : 'DATABASE.SCHEMA.TABLE';
  const cad = d.schedule && d.schedule.cadence;
  let status = '';
  if (src && obj) {
    if (cad === 'off' || cad === 'load') status = `<span class="muted">Server runs need an hourly, daily or weekly cadence.</span>`;
    else if (sc) status = `Server: next run <b>${esc(when(sc.next_run_at))}</b>${sc.last_run_at ? ` · last ${esc(when(sc.last_run_at))} ${sc.last_status === 'error' ? `<span style="color:var(--crit)">failed: ${esc(sc.last_error || 'unknown error')}</span>` : '<span style="color:var(--good)">ok</span>'}` : ''}`;
    else status = '<span class="muted">Saving…</span>';
  } else status = '<span class="muted">No source: runs when a matching file is dropped on this page.</span>';
  const id = 'sr' + d.id.replace(/[^A-Za-z0-9]/g, '');
  return `<div class="srcrow" data-src-ds="${esc(d.id)}">
    <div class="egrid">
      <label class="f"><span class="lbl">Data source</span><select class="inp" id="${id}Src"><option value="">None (file drops only)</option>${X.sources.map(s => `<option value="${esc(s.id)}"${s.id === cur ? ' selected' : ''}>${esc(KIND[s.kind] + ': ' + s.name)}</option>`).join('')}</select></label>
      <label class="f wide2"><span class="lbl">${k === 's3' ? 'S3 key or prefix' : 'Table'}</span><input class="inp mono" id="${id}Obj" type="text" spellcheck="false" maxlength="512" placeholder="${esc(ph)}" value="${esc(obj)}" ${cur ? '' : 'disabled'}></label>
    </div>
    <div class="erow"><span class="fine grow" aria-live="polite">${status}${X.msg[d.id] ? ' · ' + esc(X.msg[d.id]) : ''}</span>
      <button type="button" class="btn ghost" data-srcsave="${esc(d.id)}">Save source</button>
      <button type="button" class="btn" data-srcrun="${esc(d.id)}" ${src && obj && !X.busy[d.id] ? '' : 'disabled'}>${X.busy[d.id] ? 'Running on server…' : 'Run on server now'}</button>
    </div>
  </div>`;
}

function panel() {
  if (X.sources === null) { refresh(); return ''; }
  const rows = X.sources.map(s => {
    const c = s.config || {};
    const where = s.kind === 'snowflake' ? `${c.account || ''} · ${c.user || ''}${c.warehouse ? ' · ' + c.warehouse : ''}${c.role ? ' · ' + c.role : ''}` : `s3://${c.bucket || ''}${c.region ? ' · ' + c.region : ''}${c.endpoint ? ' · ' + c.endpoint : ''}`;
    const test = s.last_test_at ? (s.last_test_ok ? `<span style="color:var(--good)">Connected ${esc(when(s.last_test_at))}</span>` : `<span style="color:var(--crit)">Test failed: ${esc(s.last_test_msg || '')}</span>`) : '<span class="muted">Not tested yet</span>';
    return `<article class="sch"><div class="top"><h3>${esc(s.name)} <span class="tag">${esc(KIND[s.kind])}</span></h3>${test}</div>
      <div class="meta"><span class="mono">${esc(where)}</span>${X.msg['s' + s.id] ? `<span>${esc(X.msg['s' + s.id])}</span>` : ''}</div>
      <div class="acts"><button type="button" class="btn ghost" data-srctest="${esc(s.id)}" ${X.busy['s' + s.id] ? 'disabled' : ''}>${X.busy['s' + s.id] ? 'Testing…' : 'Test connection'}</button>
        <button type="button" class="btn ghost" data-srcdel="${esc(s.id)}" style="${X.confirmDel === s.id ? 'color:var(--crit);border-color:var(--crit)' : ''}">${X.confirmDel === s.id ? 'Confirm: delete source' : 'Delete'}</button></div></article>`;
  }).join('');
  const f = X.adding;
  const form = !f ? `<div class="erow"><button type="button" class="btn ghost" data-srcadd="snowflake">Add Snowflake</button><button type="button" class="btn ghost" data-srcadd="s3">Add S3</button></div>`
    : `<div class="sch"><div class="top"><h3>New ${esc(KIND[f])} source</h3></div><div class="egrid">
      <label class="f"><span class="lbl">Name</span><input class="inp" id="nsName" maxlength="80" value="${f === 'snowflake' ? 'Snowflake' : 'S3 bucket'}"></label>
      ${f === 'snowflake' ? `
      <label class="f"><span class="lbl">Account identifier</span><input class="inp mono" id="nsAccount" spellcheck="false" placeholder="myorg-myaccount"></label>
      <label class="f"><span class="lbl">User</span><input class="inp mono" id="nsUser" spellcheck="false" placeholder="DQ_SERVICE"></label>
      <label class="f"><span class="lbl">Role (optional)</span><input class="inp mono" id="nsRole" spellcheck="false"></label>
      <label class="f"><span class="lbl">Warehouse</span><input class="inp mono" id="nsWh" spellcheck="false" value="DQ_WH"></label>
      <label class="f wide"><span class="lbl">Private key (PEM, key-pair auth)</span><textarea class="inp mono" id="nsKey" rows="5" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>
      <label class="f"><span class="lbl">Key passphrase (if encrypted)</span><input class="inp" id="nsPass" type="password" autocomplete="off"></label>`
      : `
      <label class="f"><span class="lbl">Bucket</span><input class="inp mono" id="nsBucket" spellcheck="false"></label>
      <label class="f"><span class="lbl">Region</span><input class="inp mono" id="nsRegion" spellcheck="false" value="us-east-1"></label>
      <label class="f"><span class="lbl">Endpoint (S3-compatible only)</span><input class="inp mono" id="nsEndpoint" spellcheck="false" placeholder="leave blank for AWS"></label>
      <label class="f"><span class="lbl">Access key ID</span><input class="inp mono" id="nsAk" spellcheck="false" autocomplete="off"></label>
      <label class="f"><span class="lbl">Secret access key</span><input class="inp" id="nsSk" type="password" autocomplete="off"></label>`}
    </div><p class="fine">Credentials are encrypted on the server and never shown again. Use a read-only user or key.</p>
    <div class="erow end"><span class="eerr grow" id="nsErr" role="alert"></span><button type="button" class="btn ghost" id="nsCancel">Cancel</button><button type="button" class="btn" id="nsGo">Save source</button></div></div>`;
  return `<section class="panel"><div class="ph"><h2>Data sources</h2><span class="hint">read-only connections the scheduler uses</span></div>
    ${X.err ? `<p class="eerr">${esc(X.err)}</p>` : ''}
    ${X.sources.length ? `<div class="schlist">${rows}</div>` : '<div class="empty">No data sources yet. Add Snowflake or S3 so schedules can run without this page open.</div>'}
    <div style="margin-top:12px">${form}</div></section>`;
}

function val(id) { const e = $(id); return e ? e.value.trim() : ''; }

function wire(el) {
  el.querySelectorAll('[data-src-ds]').forEach(row => {
    const dsId = row.dataset.srcDs, id = 'sr' + dsId.replace(/[^A-Za-z0-9]/g, '');
    const sel = $(id + 'Src'), inp = $(id + 'Obj');
    if (sel) sel.onchange = () => { inp.disabled = !sel.value; const s = X.sources.find(x => x.id === sel.value); inp.placeholder = s && s.kind === 's3' ? 'path/to/file.csv or folder/ for the newest file' : 'DATABASE.SCHEMA.TABLE'; };
  });
  el.querySelectorAll('[data-srcsave]').forEach(b => b.onclick = () => {
    const o = ops(), d = o.state.ds[b.dataset.srcsave]; if (!d) return;
    const id = 'sr' + d.id.replace(/[^A-Za-z0-9]/g, ''), sid = val(id + 'Src'), obj = val(id + 'Obj');
    const s = X.sources.find(x => x.id === sid);
    if (sid && !obj) { X.msg[d.id] = s && s.kind === 's3' ? 'Enter the S3 key or prefix.' : 'Enter the table name.'; rerender(); return; }
    if (s && s.kind === 'snowflake' && !TABLE_RE.test(obj)) { X.msg[d.id] = 'Use DATABASE.SCHEMA.TABLE (letters, digits, _ and $; quote other names).'; rerender(); return; }
    const next = Object.assign({}, d, { source: sid ? { id: sid, object: obj } : null });
    if (!sid) delete next.source;
    o.put('datasets', next);
    X.msg[d.id] = sid ? 'Source saved.' : 'Source removed.';
    setTimeout(refresh, 900);
    rerender();
  });
  el.querySelectorAll('[data-srcrun]').forEach(b => b.onclick = async () => {
    const dsId = b.dataset.srcrun; X.busy[dsId] = true; X.msg[dsId] = ''; rerender();
    try {
      const r = await SRV.runNow(dsId);
      X.msg[dsId] = r.run ? `Ran on the server: file ${(r.run.fileScore * 100).toFixed(1)}, rules ${r.run.rulesScore === null ? '—' : (r.run.rulesScore * 100).toFixed(1)}, ${r.run.rows} rows.` : 'Run finished.';
      await ops().reload(true);
    } catch (e) { X.msg[dsId] = 'Server run failed: ' + (e.message || e); }
    finally { X.busy[dsId] = false; refresh(); }
  });
  el.querySelectorAll('[data-srcadd]').forEach(b => b.onclick = () => { X.adding = b.dataset.srcadd; rerender(); const n = $('nsName'); if (n) n.focus(); });
  if ($('nsCancel')) $('nsCancel').onclick = () => { X.adding = null; rerender(); };
  if ($('nsGo')) $('nsGo').onclick = async () => {
    const kind = X.adding, name = val('nsName');
    let config, secret;
    if (kind === 'snowflake') {
      config = { account: val('nsAccount'), user: val('nsUser'), role: val('nsRole'), warehouse: val('nsWh') };
      secret = { privateKey: $('nsKey').value.trim(), passphrase: $('nsPass').value };
      if (!config.account || !config.user || !config.warehouse || !secret.privateKey) { $('nsErr').textContent = 'Account, user, warehouse and private key are needed.'; return; }
    } else {
      config = { bucket: val('nsBucket'), region: val('nsRegion'), endpoint: val('nsEndpoint') };
      secret = { accessKeyId: val('nsAk'), secretAccessKey: $('nsSk').value };
      if (!config.bucket || !config.region || !secret.accessKeyId || !secret.secretAccessKey) { $('nsErr').textContent = 'Bucket, region and both keys are needed.'; return; }
    }
    if (!name) { $('nsErr').textContent = 'Give the source a name.'; return; }
    $('nsGo').disabled = true;
    try { await SRV.sources.create({ kind, name, config, secret }); X.adding = null; ops().toast('Source saved. Test it before scheduling.'); }
    catch (e) { $('nsErr').textContent = e.message || String(e); $('nsGo').disabled = false; return; }
    refresh();
  };
  el.querySelectorAll('[data-srctest]').forEach(b => b.onclick = async () => {
    const id = b.dataset.srctest; X.busy['s' + id] = true; X.msg['s' + id] = ''; rerender();
    try { const r = await SRV.sources.test(id); X.msg['s' + id] = r.ok ? r.message || 'Connected.' : ''; }
    catch (e) { X.msg['s' + id] = e.message || String(e); }
    finally { X.busy['s' + id] = false; refresh(); }
  });
  el.querySelectorAll('[data-srcdel]').forEach(b => b.onclick = async () => {
    const id = b.dataset.srcdel;
    if (X.confirmDel !== id) { X.confirmDel = id; rerender(); return; }
    X.confirmDel = null;
    try { await SRV.sources.remove(id); ops().toast('Source deleted. Datasets that used it now run on file drops only.'); await ops().reload(true); }
    catch (e) { ops().toast('Could not delete: ' + (e.message || e)); }
    refresh();
  });
}

window.HoloSources = { callout, cardRow, panel, wire, refresh };
})();
