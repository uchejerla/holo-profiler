// The server's time-zone aware schedule maths must give the same slots the page computes in the viewer's local time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sched from '../lib/core/schedule.js';

const here = fileURLToPath(import.meta.url);

// Child mode: run ops.js (local time) under process TZ and compare with schedule.js for that zone.
if (process.env.HOLO_SCHED_CHILD) {
  const { createRequire } = await import('node:module');
  const ops = createRequire(here)('../hud/src/ops.js');
  const tz = process.env.TZ;
  let seed = 7; const R = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const base = Date.UTC(2026, 0, 1);
  let checked = 0, diffs = [];
  for (let i = 0; i < 1500; i++) {
    const cadence = ['hourly', 'daily', 'weekly'][i % 3];
    const sch = { cadence, hour: Math.floor(R() * 24), minute: Math.floor(R() * 60), dow: Math.floor(R() * 7), since: base + Math.floor(R() * 360 * 86400e3) };
    const ds = { schedule: sch, created: sch.since, lastRunAt: R() < 0.5 ? null : sch.since + Math.floor(R() * 20 * 86400e3) };
    const now = sch.since + Math.floor(R() * 12 * 86400e3);
    const a = ops.scheduleState(ds, now), b = sched.scheduleState(ds, now, tz);
    checked++;
    if (a.due !== b.due || a.next !== b.next || a.missed !== b.missed || a.dueSince !== b.dueSince) diffs.push({ sch, ds, now, a, b });
  }
  process.stdout.write(JSON.stringify({ checked, diffs: diffs.length, sample: diffs.slice(0, 2) }));
  process.exit(0);
}

for (const tz of ['America/Chicago', 'Asia/Kolkata', 'Europe/London', 'UTC', 'Australia/Adelaide']) {
  test(`server slots match the page's local-time slots in ${tz}`, () => {
    const out = JSON.parse(execFileSync(process.execPath, [here], { env: { ...process.env, TZ: tz, HOLO_SCHED_CHILD: '1' } }).toString());
    assert.equal(out.checked, 1500);
    assert.equal(out.diffs, 0, `${out.diffs} mismatches: ${JSON.stringify(out.sample)}`);
  });
}

test('nextRunAt is null without a source or for paused / on-load schedules', () => {
  const ds = { schedule: { cadence: 'daily', hour: 7, minute: 0, since: Date.UTC(2026, 10, 1) }, created: Date.UTC(2026, 10, 1), lastRunAt: null };
  assert.equal(sched.nextRunAt(ds, Date.UTC(2026, 10, 10), 'America/Chicago', false), null);
  assert.equal(sched.nextRunAt({ ...ds, schedule: { ...ds.schedule, cadence: 'off' } }, Date.UTC(2026, 10, 10), 'UTC', true), null);
  assert.equal(sched.nextRunAt({ ...ds, schedule: { ...ds.schedule, cadence: 'load' } }, Date.UTC(2026, 10, 10), 'UTC', true), null);
});

test('daily 7:00 in Chicago is 13:00 UTC in November (CST)', () => {
  const ds = { schedule: { cadence: 'daily', hour: 7, minute: 0, since: Date.UTC(2026, 10, 10, 14) }, created: 0, lastRunAt: null };
  const t = sched.nextRunAt(ds, Date.UTC(2026, 10, 10, 15), 'America/Chicago', true);
  assert.equal(new Date(t).toISOString(), '2026-11-11T13:00:00.000Z');
});

test('a missed slot is due now and counts missed runs', () => {
  const since = Date.UTC(2026, 10, 1, 0);
  const ds = { schedule: { cadence: 'daily', hour: 7, minute: 0, since }, created: since, lastRunAt: null };
  const st = sched.scheduleState(ds, Date.UTC(2026, 10, 5, 20), 'America/Chicago');
  assert.equal(st.due, true);
  assert.equal(st.missed, 4);
  assert.equal(new Date(st.dueSince).toISOString(), '2026-11-05T13:00:00.000Z');
});

test('an invalid time zone falls back to UTC', () => {
  assert.equal(sched.validTz('Not/AZone'), false);
  const ds = { schedule: { cadence: 'daily', hour: 7, minute: 0, since: Date.UTC(2026, 10, 10, 8) }, created: 0, lastRunAt: null };
  assert.equal(new Date(sched.nextRunAt(ds, Date.UTC(2026, 10, 10, 9), 'Not/AZone', true)).toISOString(), '2026-11-11T07:00:00.000Z');
});
