// Deploy helpers: the settings check, the plan switch for vercel.json, and the secrets generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkEnv } = require('../lib/core/env-check.js');

const good = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcd.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key-value',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  CRON_SECRET: 'a'.repeat(40),
  NEXT_PUBLIC_SITE_URL: 'https://holo.example.com',
};

test('settings check passes good values and names each problem without showing values', () => {
  assert.deepEqual(checkEnv(good, { production: true }), { ok: true, problems: [] });
  const bad = checkEnv({ ...good, APP_ENCRYPTION_KEY: 'replace-with-32-byte-base64-key', CRON_SECRET: 'short', SUPABASE_SERVICE_ROLE_KEY: good.NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }, { production: true });
  const names = bad.problems.map(p => p.name);
  assert.ok(names.includes('APP_ENCRYPTION_KEY') && names.includes('CRON_SECRET') && names.includes('SUPABASE_SERVICE_ROLE_KEY') && names.includes('NEXT_PUBLIC_SUPABASE_URL'));
  assert.ok(!JSON.stringify(bad).includes('anon-key-value'), 'never echoes a value');
  assert.equal(checkEnv({ ...good, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SITE_URL: undefined }).ok, true, 'local values are fine outside production');
  assert.equal(checkEnv({ ...good, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }).ok, false);
  // New-style Supabase keys: the publishable one goes to browsers, the secret one stays on the server.
  assert.equal(checkEnv({ ...good, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_abc', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_def' }).ok, true);
  assert.deepEqual(checkEnv({ ...good, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_secret_def', SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abc' }).problems.map(p => p.name).sort(), ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
});

test('gen:secrets prints values that pass the check', () => {
  const out = execFileSync(process.execPath, ['scripts/gen-secrets.mjs'], { encoding: 'utf8' });
  const v = Object.fromEntries(out.split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(checkEnv({ ...good, ...v }, { production: true }).ok, true);
});

test('check:env reads an env file and exits non-zero on problems', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-env-'));
  const f = join(dir, '.env.test');
  writeFileSync(f, Object.entries({ ...good, CRON_SECRET: 'short' }).map(([k, v]) => `${k}="${v}"`).join('\n'));
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, ['scripts/check-env.mjs', f, '--production'], { encoding: 'utf8', env: { PATH: process.env.PATH } }); }
  catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 1);
  assert.match(out, /CRON_SECRET: too short/);
  assert.ok(!out.includes(good.APP_ENCRYPTION_KEY));
});

test('plan switch: Hobby keeps only a once-a-day Vercel Cron, Pro runs it every 15 minutes', () => {
  const orig = readFileSync('vercel.json', 'utf8');
  try {
    execFileSync(process.execPath, ['scripts/set-plan.mjs', 'pro']);
    assert.deepEqual(JSON.parse(readFileSync('vercel.json', 'utf8')).crons, [{ path: '/api/cron/run-schedules', schedule: '*/15 * * * *' }]);
    execFileSync(process.execPath, ['scripts/set-plan.mjs', 'hobby']);
    const [c] = JSON.parse(readFileSync('vercel.json', 'utf8')).crons;
    assert.equal(c.path, '/api/cron/run-schedules');
    // Hobby rejects anything more often than daily: fixed minute and hour, every day.
    const [min, hour, dom, mon, dow] = c.schedule.split(' ');
    assert.ok(/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*', c.schedule);
  } finally { writeFileSync('vercel.json', orig); }
});

test('the repo is set up for the Hobby plan, and the Supabase timer calls the scheduler every 15 minutes', () => {
  const [c] = JSON.parse(readFileSync('vercel.json', 'utf8')).crons;
  assert.match(c.schedule, /^\d+ \d+ \* \* \*$/);
  const sql = readFileSync('supabase/optional/pg_cron_tick.sql', 'utf8');
  assert.match(sql, /cron\.schedule\(\s*'holo-profiler-tick',\s*'\*\/15 \* \* \* \*'/);
  assert.match(sql, /\/api\/cron\/run-schedules/);
  assert.match(sql, /vault\.decrypted_secrets where name = 'holo_cron_secret'/);
  assert.ok(!/Bearer [A-Za-z0-9_-]{20,}/.test(sql), 'no real secret in the file');
});

test('opening an email link never spends the one-time token; only the button POST does', () => {
  const page = readFileSync(new URL('../app/auth/confirm/page.tsx', import.meta.url), 'utf8');
  const verify = readFileSync(new URL('../app/auth/verify/route.ts', import.meta.url), 'utf8');
  assert.ok(!/^[^/\n]*verifyOtp/m.test(page) && /method="post" action="\/auth\/verify"/.test(page));
  assert.ok(/export async function POST/.test(verify) && !/export async function GET/.test(verify));
});
