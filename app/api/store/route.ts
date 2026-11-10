// GET /api/store: everything the page keeps for this workspace (datasets, runs, exceptions, meta).
import { getCtx } from '@/lib/context';
import { handle, json } from '@/lib/http';
import storeMod from '@/lib/core/store.js';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const ctx = await getCtx();
  const data = await (storeMod as any).createStore(ctx.sb).loadAll(ctx.ws.id);
  return json(data);
});
