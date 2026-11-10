// Supabase client for route handlers and server components, acting as the signed-in user (row-level security applies).
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: { name: string; value: string; options?: any }[]) => {
        try { for (const { name, value, options } of list) store.set(name, value, options); }
        catch { /* called from a server component; the middleware refreshes the session instead */ }
      },
    },
  });
}
