-- OPTIONAL: use this instead of Vercel Cron (for example on Vercel's Hobby plan, whose cron runs once a day).
-- Supabase calls the app's cron route every 15 minutes with pg_cron + pg_net.
-- 1. In the Supabase dashboard, enable the pg_cron and pg_net extensions (Database > Extensions).
-- 2. Replace the two placeholders below, then run this in the SQL editor. Keep the secret out of git.
--    <APP_URL>      e.g. https://holo-profiler.vercel.app
--    <CRON_SECRET>  the same value as the CRON_SECRET environment variable in Vercel
select cron.schedule(
  'holo-profiler-tick',
  '*/15 * * * *',
  $$ select net.http_get(
       url := '<APP_URL>/api/cron/run-schedules',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'),
       timeout_milliseconds := 300000
     ); $$
);
-- To stop it: select cron.unschedule('holo-profiler-tick');
