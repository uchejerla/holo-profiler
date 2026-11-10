-- Vercel Hobby plan: Supabase calls the app's scheduler every 15 minutes (Hobby's own cron runs at most once a day).
-- Run this once in the Supabase SQL editor after the first deploy. It keeps the app address and CRON_SECRET in
-- Supabase Vault, so the secret is not written into the job itself.
--
-- Before running:
--   1. Database > Extensions: enable pg_cron and pg_net.
--   2. Replace the two placeholders below. Do not save the filled-in copy anywhere, and do not commit it.
--        <APP_URL>      your app's address with no trailing slash, e.g. https://holo-profiler.vercel.app
--        <CRON_SECRET>  the same value as the CRON_SECRET environment variable in Vercel

select vault.create_secret('<APP_URL>', 'holo_app_url', 'Holo Profiler app address for the scheduler');
select vault.create_secret('<CRON_SECRET>', 'holo_cron_secret', 'Holo Profiler CRON_SECRET for the scheduler');

select cron.schedule(
  'holo-profiler-tick',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'holo_app_url') || '/api/cron/run-schedules',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'holo_cron_secret')
    ),
    timeout_milliseconds := 300000
  );
  $$
);

-- Check it is working (after 15 minutes or so). status_code 200 means the scheduler ran.
--   select id, status_code, left(content::text, 200) as body, created
--   from net._http_response order by created desc limit 5;
--   select jobid, status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'holo-profiler-tick') order by start_time desc limit 5;
--
-- Change the address or secret later (for example after rotating CRON_SECRET):
--   select vault.update_secret((select id from vault.secrets where name = 'holo_cron_secret'), '<NEW_CRON_SECRET>');
--   select vault.update_secret((select id from vault.secrets where name = 'holo_app_url'), '<NEW_APP_URL>');
--
-- Stop it (for example after moving to Vercel Pro, whose cron then takes over):
--   select cron.unschedule('holo-profiler-tick');
--
-- Note: while a request is queued, pg_net keeps its headers, including the secret, in net.http_request_queue, which
-- database roles that can sign in may read. Keep database access to people you trust, and rotate CRON_SECRET if that changes.
