// Magic link via token hash (works even when the link is opened in a different browser than the one that asked).
// Use it by setting the Magic Link email template to: {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app
import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/safe-next';

export async function GET(req: NextRequest) {
  const token_hash = req.nextUrl.searchParams.get('token_hash');
  const type = req.nextUrl.searchParams.get('type') as EmailOtpType | null;
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  if (token_hash && type) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.verifyOtp({ token_hash, type });
    if (!error) return NextResponse.redirect(new URL(next, req.nextUrl.origin));
  }
  return NextResponse.redirect(new URL('/login?error=link', req.nextUrl.origin));
}
