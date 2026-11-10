// GET /api/health: is the app up, are its settings in place, and can it reach a migrated database?
// Reports setting names and problems only, never values. Open it right after the first deploy.
import { json } from '@/lib/http';
import envCheckMod from '@/lib/core/env-check.js';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const { checkEnv } = envCheckMod as any;

async function database(): Promise<string> {
  try {
    const { error } = await supabaseAdmin().from('workspaces').select('id', { count: 'exact', head: true });
    if (!error) return 'ok';
    if (/relation .* does not exist|schema cache|PGRST205|42P01/i.test(`${error.code} ${error.message}`)) return 'tables missing: run supabase db push';
    if (/invalid api key|jwt|401/i.test(`${error.code} ${error.message}`)) return 'service_role key rejected';
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(`${error.code} ${error.message} ${(error as any).details || ''}`)) return 'not reachable: check NEXT_PUBLIC_SUPABASE_URL';
    return 'error';
  } catch {
    return 'not reachable';
  }
}

export async function GET() {
  const production = process.env.VERCEL_ENV === 'production';
  const settings = checkEnv(process.env, { production });
  const requiredForDb = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const db = settings.problems.some((p: any) => requiredForDb.includes(p.name)) ? 'skipped: settings incomplete' : await database();
  const ok = settings.ok && db === 'ok';
  return json({
    ok,
    app: 'holo-profiler',
    settings: settings.ok ? 'ok' : settings.problems.map((p: any) => `${p.name}: ${p.problem}`),
    database: db,
  }, ok ? 200 : 503);
}
