// GET /api/schedules: server-side schedule state per dataset (next run, last result).
import { getCtx } from '@/lib/context';
import { handle, HttpError, json } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const ctx = await getCtx();
  const { data, error } = await ctx.sb.from('schedules')
    .select('dataset_id, cadence, hour, minute, dow, tz, source_id, source_object, next_run_at, last_run_at, last_status, last_error')
    .eq('workspace_id', ctx.ws.id);
  if (error) throw new HttpError(500, error.message, 'unavailable');
  return json({ schedules: data });
});
