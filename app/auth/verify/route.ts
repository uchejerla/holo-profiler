// The button on /auth/confirm posts here. This is the only place the one-time email token is spent.
import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/supabase/server';
import { safeNext } from '@/lib/safe-next';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const token_hash = String(form.get('token_hash') || '');
  const type = String(form.get('type') || '') as EmailOtpType;
  const next = safeNext(String(form.get('next') || ''));
  if (token_hash && type) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.verifyOtp({ token_hash, type });
    // 303 so the browser follows with a GET.
    if (!error) return NextResponse.redirect(new URL(next, req.nextUrl.origin), 303);
  }
  return NextResponse.redirect(new URL('/login?error=link', req.nextUrl.origin), 303);
}
