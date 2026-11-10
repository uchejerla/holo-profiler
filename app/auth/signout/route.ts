import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin && origin !== req.nextUrl.origin) return new NextResponse('Forbidden', { status: 403 });
  const sb = await supabaseServer();
  await sb.auth.signOut();
  return NextResponse.redirect(new URL('/login', req.nextUrl.origin), 303);
}
