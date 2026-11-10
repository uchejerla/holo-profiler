-- Scheduler support: atomically claim due schedules so overlapping cron ticks never run a dataset twice.
-- Only the service role (the app's cron route) may call it.
create or replace function public.claim_due_schedules(p_now timestamptz, p_limit integer, p_lock_until timestamptz)
returns table (workspace_id uuid, dataset_id text)
language sql security definer set search_path = public as $$
  update public.schedules s
     set lock_until = p_lock_until
   where (s.workspace_id, s.dataset_id) in (
           select d.workspace_id, d.dataset_id
             from public.schedules d
            where d.source_id is not null
              and d.source_object is not null
              and d.cadence in ('hourly', 'daily', 'weekly')
              and d.next_run_at <= p_now
              and (d.lock_until is null or d.lock_until < p_now)
            order by d.next_run_at
            limit greatest(1, least(p_limit, 100))
            for update skip locked)
  returning s.workspace_id, s.dataset_id;
$$;
revoke execute on function public.claim_due_schedules(timestamptz, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_due_schedules(timestamptz, integer, timestamptz) to service_role;
