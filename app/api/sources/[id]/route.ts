// DELETE /api/sources/:id. Datasets that used it fall back to file drops.
import type { NextRequest } from 'next/server';
import { getCtx, requireAdmin } from '@/lib/context';
import { checkSameOrigin, handle, HttpError, json } from '@/lib/http';
import storeMod from '@/lib/core/store.js';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ id: string }> };

export const DELETE = handle(async (req: NextRequest, { params }: P) => {
  checkSameOrigin(req);
  const { id } = await params;
  const ctx = await getCtx();
  requireAdmin(ctx);
  const store = (storeMod as any).createStore(ctx.sb);
  const { data: users, error } = await ctx.sb.from('datasets').select('doc').eq('workspace_id', ctx.ws.id).eq('doc->source->>id', id);
  if (error) throw new HttpError(500, error.message);
  for (const r of users || []) { const d = { ...r.doc }; delete d.source; await store.write(ctx.ws.id, 'datasets', d.id, d, { actor: ctx.user.id }); }
  const { data: gone, error: e2 } = await ctx.sb.from('sources').delete().eq('workspace_id', ctx.ws.id).eq('id', id).select('id');
  if (e2) throw new HttpError(500, e2.message);
  if (!gone || !gone.length) throw new HttpError(404, 'No such source');
  return json({ ok: true, detached: (users || []).length });
});
