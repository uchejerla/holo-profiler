// GET /api/sources: the workspace's data sources (never their secrets).
// POST /api/sources: add one. The secret is encrypted with APP_ENCRYPTION_KEY and stored where only the server can read it.
import type { NextRequest } from 'next/server';
import { getCtx, requireAdmin } from '@/lib/context';
import { checkSameOrigin, handle, HttpError, json, readJson } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { requirePro } from '@/lib/billing';
import sourcesMod from '@/lib/core/sources.js';
import cryptoMod from '@/lib/core/crypto.js';

export const dynamic = 'force-dynamic';
const { cleanConfig, cleanSecret } = sourcesMod as any;
const { encrypt } = cryptoMod as any;
const COLS = 'id, kind, name, config, last_test_at, last_test_ok, last_test_msg, created_at';

export const GET = handle(async () => {
  const ctx = await getCtx();
  const { data, error } = await ctx.sb.from('sources').select(COLS).eq('workspace_id', ctx.ws.id).order('created_at');
  if (error) throw new HttpError(500, error.message, 'unavailable');
  return json({ sources: data });
});

export const POST = handle(async (req: NextRequest) => {
  checkSameOrigin(req);
  const ctx = await getCtx();
  requireAdmin(ctx);
  requirePro(ctx);
  const b = await readJson(req, 64 * 1024);
  const kind = b?.kind, name = String(b?.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give the source a name');
  let config, secret;
  try { config = cleanConfig(kind, b?.config); secret = cleanSecret(kind, b?.secret); }
  catch (e: any) { throw new HttpError(400, e.message, 'invalid'); }
  const key = env.encryptionKey();
  const { data: row, error } = await ctx.sb.from('sources').insert({ workspace_id: ctx.ws.id, kind, name, config, created_by: ctx.user.id }).select(COLS).single();
  if (error) throw new HttpError(error.code === '42501' ? 403 : 500, error.message);
  const admin = supabaseAdmin();
  const { error: e2 } = await admin.from('source_secrets').insert({ source_id: row.id, workspace_id: ctx.ws.id, ciphertext: encrypt(secret, key, row.id) });
  if (e2) { await admin.from('sources').delete().eq('id', row.id); throw new HttpError(500, 'Could not save the credentials: ' + e2.message); }
  return json({ source: row }, 201);
});
