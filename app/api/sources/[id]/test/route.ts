// POST /api/sources/:id/test: sign in to the source and report who we are there.
import type { NextRequest } from 'next/server';
import { getCtx, requireWriter } from '@/lib/context';
import { checkSameOrigin, handle, HttpError, json } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadSource } from '@/lib/server-deps';
import sourcesMod from '@/lib/core/sources.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type P = { params: Promise<{ id: string }> };

export const POST = handle(async (req: NextRequest, { params }: P) => {
  checkSameOrigin(req);
  const { id } = await params;
  const ctx = await getCtx();
  requireWriter(ctx);
  const { data: mine } = await ctx.sb.from('sources').select('id').eq('workspace_id', ctx.ws.id).eq('id', id).maybeSingle();
  if (!mine) throw new HttpError(404, 'No such source');
  const { source, secret } = await loadSource(ctx.ws.id, id);
  let ok = false, message = '';
  try { message = await (sourcesMod as any).testSource(source, secret); ok = true; }
  catch (e: any) { message = String(e?.message || e).slice(0, 300); }
  await supabaseAdmin().from('sources').update({ last_test_at: new Date().toISOString(), last_test_ok: ok, last_test_msg: message }).eq('id', id);
  if (!ok) throw new HttpError(400, message, 'source_error');
  return json({ ok, message });
});
