// GET /api/cron/run-schedules: called every 15 minutes by Vercel Cron (or Supabase pg_cron). Runs due schedules.
// Authenticated with `Authorization: Bearer <CRON_SECRET>`, which Vercel Cron sends automatically when CRON_SECRET is set.
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { handle, json } from '@/lib/http';
import { serverDeps } from '@/lib/server-deps';
import runnerMod from '@/lib/core/runner.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorized(req: NextRequest) {
  const got = Buffer.from(req.headers.get('authorization') || '');
  const want = Buffer.from('Bearer ' + env.cronSecret());
  return got.length === want.length && timingSafeEqual(got, want);
}

export const GET = handle(async (req: NextRequest) => {
  if (!process.env.CRON_SECRET) return json({ error: 'CRON_SECRET is not set on the server, so scheduled runs are off.' }, 503);
  if (!authorized(req)) return json({ error: 'Unauthorized' }, 401);
  const results = await (runnerMod as any).runDue(serverDeps(), { budgetMs: 240e3, limit: 25 });
  return json({ ran: results.filter((r: any) => r.ok).length, failed: results.filter((r: any) => r.ok === false).length, results });
});
