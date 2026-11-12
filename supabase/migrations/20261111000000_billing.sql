-- Billing: each workspace is on the free or the pro plan. Only the Stripe webhook (service role) changes it.
alter table public.workspaces
  add column plan text not null default 'free' check (plan in ('free', 'pro')),
  add column stripe_customer_id text;

-- ws_update lets admins update their workspace row; without this they could set plan = 'pro' themselves.
revoke update on public.workspaces from authenticated;
grant update (name) on public.workspaces to authenticated;

-- The scheduler can skip workspaces that are not on the pro plan (p_paid_only, set by the app when billing is on),
-- so unpaid schedules never take a slot from paying ones.
drop function public.claim_due_schedules(timestamptz, integer, timestamptz);
create function public.claim_due_schedules(p_now timestamptz, p_limit integer, p_lock_until timestamptz, p_paid_only boolean default false)
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
              and (not p_paid_only or exists (select 1 from public.workspaces w where w.id = d.workspace_id and w.plan = 'pro'))
            order by d.next_run_at
            limit greatest(1, least(p_limit, 100))
            for update skip locked)
  returning s.workspace_id, s.dataset_id;
$$;
revoke execute on function public.claim_due_schedules(timestamptz, integer, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.claim_due_schedules(timestamptz, integer, timestamptz, boolean) to service_role;
