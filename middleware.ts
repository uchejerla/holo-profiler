// Keeps the Supabase session cookie fresh on every request and sends signed-out visitors of /app to /login.
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return res;
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list: { name: string; value: string; options?: any }[]) => {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user && req.nextUrl.pathname === '/app') {
    const to = req.nextUrl.clone(); to.pathname = '/login'; to.search = '?next=/app';
    return NextResponse.redirect(to);
  }
  return res;
}

export const config = {
  // Not for static files or the cron route (which authenticates with CRON_SECRET, not a session).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/cron|api/health).*)'],
};
