// Service-role client. Bypasses row-level security: use only on the server, only after checking membership,
// and only for the scheduler and encrypted source secrets.
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

export function supabaseAdmin() {
  return createClient(env.supabaseUrl(), env.serviceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
}
