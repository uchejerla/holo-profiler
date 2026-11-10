// Switches vercel.json for your Vercel plan.
//   npm run plan:pro    Vercel Cron calls the scheduler every 15 minutes (needs Vercel Pro).
//   npm run plan:hobby  Vercel Cron calls it once a day only, as a backup, because Hobby allows nothing more frequent
//                       (a more frequent cron makes the deploy fail). The 15-minute runs come from Supabase instead:
//                       see supabase/optional/pg_cron_tick.sql. Overlapping calls are safe: each dataset is locked
//                       while it runs, and one that is not due is skipped.
import { readFileSync, writeFileSync } from 'node:fs';
export const SCHEDULES = { pro: '*/15 * * * *', hobby: '0 11 * * *' }; // hobby: once a day, 11:00 UTC (5 or 6 AM Central)
const plan = process.argv[2];
if (plan !== 'pro' && plan !== 'hobby') { console.error('Usage: node scripts/set-plan.mjs pro|hobby'); process.exit(1); }
const path = new URL('../vercel.json', import.meta.url);
const cfg = JSON.parse(readFileSync(path, 'utf8'));
cfg.crons = [{ path: '/api/cron/run-schedules', schedule: SCHEDULES[plan] }];
writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log(plan === 'pro'
  ? 'vercel.json: Vercel Cron every 15 minutes. Commit this change. If you set up the Supabase timer earlier, stop it: select cron.unschedule(\'holo-profiler-tick\');'
  : 'vercel.json: Vercel Cron once a day as a backup. Commit this change, then set up supabase/optional/pg_cron_tick.sql after the first deploy.');
