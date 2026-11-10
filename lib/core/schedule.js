/* Time-zone aware schedule maths for the server.
   The page computes slots in the viewer's local time (ops.js slotAfter uses Date#setHours). A server runs in UTC,
   so this file computes the same slots in the schedule's own time zone, matching the page's results. */
'use strict';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TIMED = new Set(['hourly', 'daily', 'weekly']);
const fmts = new Map();

function validTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    fmts.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// Wall-clock parts of instant t in tz.
function parts(t, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour % 24, M: +o.minute, S: +o.second, dow: WD[o.weekday] };
}
function offset(t, tz) { const p = parts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) - (t - (((t % 1000) + 1000) % 1000)); }
// Wall clock in tz to an instant, resolving gaps and overlaps the way JavaScript's Date does
// (a time that does not exist moves forward; a time that happens twice takes the earlier one).
function zoned(y, m, d, H, M, tz) {
  const guess = Date.UTC(y, m - 1, d, H, M, 0, 0), w = new Date(guess);
  const ob = offset(guess - 12 * HOUR, tz), oa = offset(guess + 12 * HOUR, tz);
  const ok = t => { const p = parts(t, tz); return p.H === w.getUTCHours() && p.M === w.getUTCMinutes() && p.d === w.getUTCDate(); };
  const ta = guess - ob, tb = guess - oa, va = ok(ta), vb = ok(tb);
  if (va && vb) return Math.min(ta, tb);   // happens twice: the earlier one
  if (va) return ta;
  if (vb) return tb;
  return ta;                                // does not exist: move forward by the gap
}

function slotAfter(sch, t, tz) {
  const H = sch.hour | 0, M = sch.minute | 0;
  const p = parts(t, tz);
  if (sch.cadence === 'hourly') {
    let s = zoned(p.y, p.m, p.d, p.H, M, tz);
    // Step one local hour at a time, like Date#setHours(h + 1): plain +1h except across a clock change.
    while (s <= t) {
      let n = s + HOUR;
      if (offset(n, tz) !== offset(s, tz)) { const q = parts(s, tz); n = zoned(q.y, q.m, q.d, q.H + 1, q.M, tz); }
      s = n;
    }
    return s;
  }
  if (sch.cadence === 'daily') {
    let k = 0, s = zoned(p.y, p.m, p.d, H, M, tz);
    while (s <= t) { k++; s = zoned(p.y, p.m, p.d + k, H, M, tz); }
    return s;
  }
  if (sch.cadence === 'weekly') {
    let k = ((sch.dow | 0) - p.dow + 7) % 7, s = zoned(p.y, p.m, p.d + k, H, M, tz);
    while (s <= t) { k += 7; s = zoned(p.y, p.m, p.d + k, H, M, tz); }
    return s;
  }
  return null;
}

// Same contract as ops.js scheduleState, in the schedule's time zone.
function scheduleState(ds, now, tz) {
  tz = validTz(tz) ? tz : 'UTC';
  const sch = ds.schedule || {};
  if (sch.cadence === 'off') return { cadence: 'off', due: false, missed: 0, next: null, dueSince: null };
  if (sch.cadence === 'load') return { cadence: 'load', due: true, missed: 0, next: null, dueSince: null, onLoad: true };
  const anchor = Math.max(ds.lastRunAt || 0, sch.since || ds.created || 0);
  const first = slotAfter(sch, anchor, tz);
  if (first === null) return { cadence: sch.cadence, due: false, missed: 0, next: null, dueSince: null };
  if (first > now) return { cadence: sch.cadence, due: false, missed: 0, next: first, dueSince: null };
  let n = 0, s = first, last = first;
  while (s <= now && n < 2000) { last = s; n++; s = slotAfter(sch, s, tz); }
  return { cadence: sch.cadence, due: true, missed: Math.max(0, n - 1), next: s, dueSince: last, firstMissed: first };
}

// When the server should next look at a dataset: the slot it is due for (possibly in the past) or the next one.
// Null when the server never runs it (no source, paused, or run-on-load only).
function nextRunAt(ds, now, tz, hasSource) {
  const cad = ds.schedule && ds.schedule.cadence;
  if (!hasSource || !TIMED.has(cad)) return null;
  const st = scheduleState(ds, now, tz);
  return st.due ? st.dueSince : st.next;
}

module.exports = { MIN, HOUR, DAY, TIMED, validTz, parts, zoned, slotAfter, scheduleState, nextRunAt };
