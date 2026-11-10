// GET /app: the Holo Profiler page, served only to signed-in members, with their account and workspace injected.
import { NextResponse } from 'next/server';
import { getCtx } from '@/lib/context';
import { HUD_BEFORE, HUD_AFTER } from '@/lib/hud/hud-html.generated';

export const dynamic = 'force-dynamic';

// JSON that is safe inside a <script> element.
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export async function GET(req: Request) {
  let ctx;
  try { ctx = await getCtx(); }
  catch (e: any) {
    if (e?.status === 401) return NextResponse.redirect(new URL('/login?next=/app', req.url));
    return new NextResponse('Could not open your workspace: ' + String(e?.message || e), { status: e?.status || 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const config = { user: { email: ctx.user.email }, workspace: { id: ctx.ws.id, name: ctx.ws.name, role: ctx.ws.role } };
  return new NextResponse(HUD_BEFORE + scriptJson(config) + HUD_AFTER, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}
