// POST /api/datasets/:id/run: run a dataset against its source now, on the server.
import type { NextRequest } from 'next/server';
import { getCtx, requireWriter } from '@/lib/context';
import { checkSameOrigin, handle, HttpError, json } from '@/lib/http';
import { serverDeps } from '@/lib/server-deps';
import runnerMod from '@/lib/core/runner.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
type P = { params: Promise<{ id: string }> };
const { runDataset, LOCK_MS } = runnerMod as any;

export const POST = handle(async (req: NextRequest, { params }: P) => {
  checkSameOrigin(req);
  const { id } = await params;
  const ctx = await getCtx();
  requireWriter(ctx);
  const { data: mine } = await ctx.sb.from('datasets').select('id').eq('workspace_id', ctx.ws.id).eq('id', id).maybeSingle();
  if (!mine) throw new HttpError(404, 'No such dataset');
  const deps = serverDeps();
  const now = new Date();
  // Take the same lock the scheduler uses, so a manual run and a scheduled run never overlap.
  const { data: locked, error } = await deps.admin.from('schedules').update({ lock_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq('workspace_id', ctx.ws.id).eq('dataset_id', id).or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`).select('dataset_id');
  if (error) throw new HttpError(500, error.message);
  if (!locked || !locked.length) throw new HttpError(409, 'This dataset is already running. Try again in a few minutes.', 'busy');
  const store = deps.storeFor(ctx.ws.id);
  try {
    const r = await runDataset({ ...deps, store }, ctx.ws.id, id, 'manual', Date.now());
    return json({ run: r.run, exceptions: r.stats });
  } catch (e: any) {
    await store.setScheduleStatus(ctx.ws.id, id, { lock_until: null, last_status: 'error', last_error: String(e?.message || e).slice(0, 400), last_run_at: new Date().toISOString() });
    throw Object.assign(new HttpError(typeof e?.status === 'number' ? e.status : 502, String(e?.message || e)), { expose: true });
  }
});
