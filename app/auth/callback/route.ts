// The magic link lands here with a one-time code (PKCE). Exchange it for a session, then go to the app.
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/safe-next';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, req.nextUrl.origin));
  }
  return NextResponse.redirect(new URL('/login?error=link', req.nextUrl.origin));
}
