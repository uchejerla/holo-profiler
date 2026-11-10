// Switches vercel.json for your Vercel plan.
//   npm run plan:pro    Vercel Cron calls the scheduler every 15 minutes (needs Vercel Pro).
//   npm run plan:hobby  No Vercel Cron (Hobby only allows a daily cron, and a more frequent one fails the deploy).
//                       Use supabase/optional/pg_cron_tick.sql to call the scheduler every 15 minutes instead.
import { readFileSync, writeFileSync } from 'node:fs';
const plan = process.argv[2];
if (plan !== 'pro' && plan !== 'hobby') { console.error('Usage: node scripts/set-plan.mjs pro|hobby'); process.exit(1); }
const path = new URL('../vercel.json', import.meta.url);
const cfg = JSON.parse(readFileSync(path, 'utf8'));
if (plan === 'pro') cfg.crons = [{ path: '/api/cron/run-schedules', schedule: '*/15 * * * *' }];
else delete cfg.crons;
writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log(plan === 'pro'
  ? 'vercel.json: Vercel Cron every 15 minutes. Commit this change before deploying.'
  : 'vercel.json: no Vercel Cron. Commit this change, then set up supabase/optional/pg_cron_tick.sql after the first deploy.');
