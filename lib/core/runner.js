/* Server runs: read a dataset's source, profile it, run its saved rule set, record the run and update exceptions,
   using the very same engine.js / rules.js / ops.js functions the page uses. */
'use strict';
const DQ = require('../../hud/src/engine.js');
const OPS = require('../../hud/src/ops.js');
const { scheduleState, nextRunAt } = require('./schedule.js');
const { iso } = require('./store.js');

const LOCK_MS = 15 * 60e3;

/**
 * Run one dataset now.
 * deps: { store (createStore), loadSource(ws, sourceId) -> { source, secret }, fetchRows(source, secret, object) -> { headers, rows, total, file } }
 * kind: 'scheduled' (cron) or 'manual' (Run on server now)
 */
async function runDataset(deps, ws, dsId, kind, now) {
  const { store } = deps;
  now = now || Date.now();
  const ds = await store.datasetDoc(ws, dsId);
  if (!ds) throw Object.assign(new Error('Dataset not found'), { status: 404 });
  const sch = await store.schedule(ws, dsId);
  if (!sch || !sch.source_id || !sch.source_object) throw Object.assign(new Error('This dataset has no data source. Pick one on the Schedules tab.'), { status: 400 });
  const { source, secret } = await deps.loadSource(ws, sch.source_id);
  const data = await deps.fetchRows(source, secret, sch.source_object);
  if (!data.headers || !data.headers.length) throw new Error('The source returned no columns.');

  const p = DQ.profileTable({ headers: data.headers, rows: data.rows, now, sampled: data.total > data.rows.length, totalRows: data.total });
  const headers = p.headers, rows = data.rows;
  const runs = await store.runsOf(ws, dsId);
  let prev = null; for (const r of runs) if (!prev || r.at > prev.at) prev = r;
  const st = scheduleState(ds, now, sch.tz);
  const missed = kind === 'scheduled' && st.due ? st.missed : 0;
  const built = OPS.buildRun({ ds, p, rows, headers, now, kind, missed, file: data.file, prevRun: prev, sample: false });
  built.run.server = true;
  built.run.source = { kind: source.kind, object: OPS.clip(sch.source_object, 200) };
  const exMap = await store.exceptionsOf(ws, dsId);
  const res = OPS.applyRun(exMap, ds, built, { rows, headers });
  const d = Object.assign({}, ds, { schema: built.run.schema, sig: OPS.headerSig(headers), lastRunAt: now, lastRunId: built.run.id,
    lastFile: OPS.clip(data.file, 160), runCount: (ds.runCount || 0) + 1, keyCol: ds.keyCol || OPS.keyColumn(p) || null });

  const ctx = { tz: sch.tz };
  await store.write(ws, 'runs', built.run.id, built.run, ctx);
  await store.write(ws, 'datasets', d.id, d, ctx);
  for (const ex of res.changed) await store.write(ws, 'exceptions', ex.id, ex, ctx);
  for (const id of OPS.pruneRuns(runs.concat([built.run]), dsId)) await store.write(ws, 'runs', id, null, ctx);
  await store.setScheduleStatus(ws, dsId, { last_run_at: iso(now), last_status: 'ok', last_error: null, lock_until: null,
    next_run_at: iso(nextRunAt(d, now + 1, sch.tz, true)) });
  return { run: built.run, stats: res.stats, alerts: built.run.alerts };
}

/**
 * Cron tick: run every dataset whose schedule is due, oldest first, within a time budget.
 * claimDue(nowIso, limit, lockUntilIso) must atomically claim due schedules (sets lock_until) and return [{ workspace_id, dataset_id }].
 */
async function runDue(deps, opts) {
  opts = opts || {};
  const started = Date.now(), budget = opts.budgetMs || 240e3, limit = opts.limit || 20, out = [];
  const claimed = await deps.claimDue(new Date(started).toISOString(), limit, new Date(started + LOCK_MS).toISOString());
  for (const c of claimed) {
    if (Date.now() - started > budget) { await deps.release(c.workspace_id, c.dataset_id); out.push({ ...c, skipped: 'time budget' }); continue; }
    const store = deps.storeFor(c.workspace_id);
    try {
      const r = await runDataset(Object.assign({}, deps, { store }), c.workspace_id, c.dataset_id, 'scheduled', Date.now());
      out.push({ ...c, ok: true, run: r.run.id, fileScore: r.run.fileScore, rulesScore: r.run.rulesScore, exceptions: r.stats });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 400);
      // Try again at the next slot rather than every tick; the failure is shown on the Schedules tab.
      let next = null;
      try {
        const ds = await store.datasetDoc(c.workspace_id, c.dataset_id), sch = await store.schedule(c.workspace_id, c.dataset_id);
        if (ds && sch) next = iso(nextRunAt(Object.assign({}, ds, { lastRunAt: Date.now() }), Date.now(), sch.tz, true));
      } catch (e2) { /* keep next null */ }
      await store.setScheduleStatus(c.workspace_id, c.dataset_id, { last_run_at: new Date().toISOString(), last_status: 'error', last_error: msg, lock_until: null, next_run_at: next });
      out.push({ ...c, ok: false, error: msg });
    }
  }
  return out;
}

module.exports = { runDataset, runDue, LOCK_MS };
