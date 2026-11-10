// PUT / DELETE /api/store/:collection/:id. The page saves each changed object here; RLS limits writes to the caller's workspace.
import type { NextRequest } from 'next/server';
import { getCtx, requireWriter } from '@/lib/context';
import { checkSameOrigin, handle, json, readJson } from '@/lib/http';
import storeMod from '@/lib/core/store.js';

export const dynamic = 'force-dynamic';
type P = { params: Promise<{ coll: string; id: string }> };

async function write(req: NextRequest, { params }: P, del: boolean) {
  checkSameOrigin(req);
  const { coll, id } = await params;
  const ctx = await getCtx();
  requireWriter(ctx);
  const body = del ? null : await readJson(req);
  if (!del && body === null) return json({ error: 'Empty body' }, 400);
  await (storeMod as any).createStore(ctx.sb).write(ctx.ws.id, coll, id, body, { tz: req.headers.get('x-holo-tz'), actor: ctx.user.id });
  return json({ ok: true });
}
export const PUT = handle((req: NextRequest, p: P) => write(req, p, false));
export const DELETE = handle((req: NextRequest, p: P) => write(req, p, true));
