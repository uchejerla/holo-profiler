/* Checks that the app's settings are present and well formed, without ever printing their values.
   Used by `npm run check:env` before a deploy and by /api/health after one. */
'use strict';

const REQUIRED = [
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase > Project Settings > API > Project URL'],
  ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Supabase > Project Settings > API > anon public key'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase > Project Settings > API > service_role key'],
  ['APP_ENCRYPTION_KEY', 'run: npm run gen:secrets'],
  ['CRON_SECRET', 'run: npm run gen:secrets'],
];
const PLACEHOLDER = /^replace-with|^<|^x$|^changeme$/i;

function checkEnv(env, opts) {
  const production = !!(opts && opts.production);
  const problems = [];
  const add = (name, msg, where) => problems.push({ name, problem: msg, where: where || '' });
  for (const [name, where] of REQUIRED) {
    const v = env[name];
    if (!v) add(name, 'missing', where);
    else if (PLACEHOLDER.test(v)) add(name, 'still the example placeholder', where);
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (url && !PLACEHOLDER.test(url)) {
    let u = null; try { u = new URL(url); } catch (e) { add('NEXT_PUBLIC_SUPABASE_URL', 'not a valid address'); }
    if (u && production && u.protocol !== 'https:') add('NEXT_PUBLIC_SUPABASE_URL', 'must start with https:// in production');
    if (u && production && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) add('NEXT_PUBLIC_SUPABASE_URL', 'points at a local Supabase, not your hosted project');
  }
  const key = env.APP_ENCRYPTION_KEY;
  if (key && !PLACEHOLDER.test(key)) {
    let n = 0; try { n = Buffer.from(key, 'base64').length; } catch (e) { n = 0; }
    if (n !== 32) add('APP_ENCRYPTION_KEY', 'must be 32 random bytes in base64 (44 characters)', 'run: npm run gen:secrets');
  }
  const cron = env.CRON_SECRET;
  if (cron && !PLACEHOLDER.test(cron) && cron.length < 24) add('CRON_SECRET', 'too short; use at least 24 random characters', 'run: npm run gen:secrets');
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, svc = env.SUPABASE_SERVICE_ROLE_KEY;
  if (anon && svc && anon === svc) add('SUPABASE_SERVICE_ROLE_KEY', 'is the same as the anon key; copy the service_role key instead');
  const site = env.NEXT_PUBLIC_SITE_URL;
  if (production && !site) add('NEXT_PUBLIC_SITE_URL', 'missing; set it to the app\'s public address', 'your Vercel domain');
  else if (site) { try { const s = new URL(site); if (production && s.protocol !== 'https:') add('NEXT_PUBLIC_SITE_URL', 'must start with https:// in production'); } catch (e) { add('NEXT_PUBLIC_SITE_URL', 'not a valid address'); } }
  return { ok: problems.length === 0, problems };
}

module.exports = { checkEnv, REQUIRED };
