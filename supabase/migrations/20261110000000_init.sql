-- Holo Profiler: core schema.
-- Every row belongs to a workspace. A user sees and changes only rows of workspaces they are a member of
-- (row-level security below). The scheduler uses the service role, which bypasses RLS by design.
--
-- The page keeps each object's full JSON in a `doc` column so behaviour stays identical to the prototype;
-- the typed columns next to it are what the scheduler, reports and policies query.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- workspaces
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

-- Membership checks used by every policy. SECURITY DEFINER so the check itself is not filtered by RLS
-- on workspace_members (which would recurse).
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

create or replace function public.can_write(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'member'));
$$;

create or replace function public.is_admin(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'admin'));
$$;

-- Every new user gets a personal workspace they own.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into public.workspaces (name, created_by)
  values (coalesce(nullif(split_part(new.email, '@', 1), ''), 'My') || '''s workspace', new.id)
  returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- sources (Snowflake, S3)
-- Non-secret connection settings live here and are readable by members.
create table public.sources (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind         text not null check (kind in ('snowflake', 's3')),
  name         text not null check (char_length(name) between 1 and 80),
  config       jsonb not null default '{}'::jsonb,   -- account, user, warehouse, role / bucket, region, endpoint
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_msg text,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index sources_ws_idx on public.sources (workspace_id);

-- Secrets (Snowflake private key + passphrase, AWS keys) are AES-256-GCM ciphertext made by the app
-- with APP_ENCRYPTION_KEY. RLS is on with no policies, so only the service role can read or write them.
create table public.source_secrets (
  source_id    uuid primary key references public.sources (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ciphertext   text not null,
  key_version  smallint not null default 1,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- datasets and rule sets
create table public.datasets (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id           text not null check (id ~ '^[A-Za-z0-9._-]{1,120}$'),
  name         text not null,
  stem         text,
  schema_sig   text,                         -- header signature, used to match dropped files
  key_col      text,
  is_sample    boolean not null default false,
  rule_set_version integer,
  last_run_at  timestamptz,
  doc          jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index datasets_sig_idx on public.datasets (workspace_id, schema_sig);

-- Every saved version of a dataset's rule set is kept.
create table public.rule_sets (
  workspace_id uuid not null,
  dataset_id   text not null,
  version      integer not null,
  name         text not null,
  rules        jsonb not null,
  rule_count   integer not null default 0,
  saved_at     timestamptz not null default now(),
  saved_by     uuid references auth.users (id) on delete set null,
  primary key (workspace_id, dataset_id, version),
  foreign key (workspace_id, dataset_id) references public.datasets (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------- schedules
-- One schedule per dataset. The page edits it inside the dataset; the app keeps this table in step.
-- A schedule runs on the server only when it has a source; otherwise it runs when a matching file is dropped.
create table public.schedules (
  workspace_id  uuid not null,
  dataset_id    text not null,
  cadence       text not null check (cadence in ('load', 'hourly', 'daily', 'weekly', 'off')),
  hour          smallint not null default 7 check (hour between 0 and 23),
  minute        smallint not null default 0 check (minute between 0 and 59),
  dow           smallint not null default 1 check (dow between 0 and 6),
  tz            text not null default 'UTC',
  since         timestamptz,
  source_id     uuid references public.sources (id) on delete set null,
  source_object text,                        -- Snowflake table (DB.SCHEMA.TABLE) or S3 key / prefix ending in /
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_status   text,                        -- ok | error
  last_error    text,
  lock_until    timestamptz,                 -- set while a worker is running it, so two ticks never run it twice
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, dataset_id),
  foreign key (workspace_id, dataset_id) references public.datasets (workspace_id, id) on delete cascade
);
create index schedules_due_idx on public.schedules (next_run_at) where source_id is not null and cadence in ('hourly', 'daily', 'weekly');

-- ---------------------------------------------------------------- runs and rule results
create table public.runs (
  workspace_id     uuid not null,
  id               text not null check (id ~ '^[A-Za-z0-9._-]{1,120}$'),
  dataset_id       text not null,
  at               timestamptz not null,
  kind             text not null,            -- manual | scheduled | load | baseline | sample
  trigger          text not null default 'browser' check (trigger in ('browser', 'server')),
  file             text,
  row_count        integer,
  col_count        integer,
  sampled          boolean,
  file_score       double precision,
  rules_score      double precision,
  rows_pass_all    double precision,
  failing_critical integer,
  active_rules     integer,
  passing_rules    integer,
  rule_set_version integer,
  doc              jsonb not null,
  created_at       timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, dataset_id) references public.datasets (workspace_id, id) on delete cascade
);
create index runs_ds_at_idx on public.runs (workspace_id, dataset_id, at desc);

-- One row per rule per run, for trends and reporting outside the page.
create table public.rule_results (
  workspace_id uuid not null,
  run_id       text not null,
  rule_id      text not null,
  pass_rate    double precision,
  failed       integer not null default 0,
  checked      integer not null default 0,
  severity     text,
  errored      boolean not null default false,
  primary key (workspace_id, run_id, rule_id),
  foreign key (workspace_id, run_id) references public.runs (workspace_id, id) on delete cascade
);

-- ---------------------------------------------------------------- exceptions
create table public.exceptions (
  workspace_id  uuid not null,
  id            text not null check (id ~ '^[A-Za-z0-9._-]{1,120}$'),
  dedupe_key    text not null,              -- dataset|rule|rule-id, dataset|drift|..., dataset|drop|...
  dataset_id    text not null,
  kind          text not null check (kind in ('rule', 'drift', 'alert')),
  rule_id       text,
  severity      text,
  status        text not null check (status in ('open', 'assigned', 'in_progress', 'resolved', 'waived')),
  owner         text,
  waive_reason  text,
  waive_until   timestamptz,
  failed_rows   integer,
  first_seen    timestamptz,
  last_seen     timestamptz,
  resolved_at   timestamptz,
  doc           jsonb not null,             -- includes notes, log and sample keys
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, dedupe_key),
  foreign key (workspace_id, dataset_id) references public.datasets (workspace_id, id) on delete cascade,
  check (status <> 'waived' or coalesce(btrim(waive_reason), '') <> '')
);
create index exceptions_status_idx on public.exceptions (workspace_id, status);

-- Small per-workspace page state (sample seeded, cleared flags).
create table public.workspace_meta (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id           text not null check (id ~ '^[A-Za-z0-9._-]{1,120}$'),
  doc          jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);

-- ---------------------------------------------------------------- audit log
-- Written only by triggers. actor is null when the scheduler (service role) made the change.
create table public.audit_log (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor        uuid,
  action       text not null,
  entity       text not null,
  entity_id    text,
  detail       jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index audit_ws_at_idx on public.audit_log (workspace_id, at desc);

create or replace function public.audit(ws uuid, act text, ent text, eid text, det jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (workspace_id, actor, action, entity, entity_id, detail)
  values (ws, auth.uid(), act, ent, eid, coalesce(det, '{}'::jsonb));
$$;
revoke execute on function public.audit(uuid, text, text, text, jsonb) from public, anon, authenticated;

create or replace function public.trg_audit_dataset()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.workspace_id, 'dataset.created', 'dataset', new.id, jsonb_build_object('name', new.name));
  elsif tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'dataset.deleted', 'dataset', old.id, jsonb_build_object('name', old.name));
    return old;
  elsif new.name is distinct from old.name then
    perform public.audit(new.workspace_id, 'dataset.renamed', 'dataset', new.id, jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  return new;
end $$;
create trigger audit_datasets after insert or update or delete on public.datasets
  for each row execute function public.trg_audit_dataset();

create or replace function public.trg_audit_rule_set()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.audit(new.workspace_id, 'rule_set.saved', 'dataset', new.dataset_id,
    jsonb_build_object('version', new.version, 'name', new.name, 'rules', new.rule_count));
  return new;
end $$;
create trigger audit_rule_sets after insert on public.rule_sets
  for each row execute function public.trg_audit_rule_set();

create or replace function public.trg_audit_schedule()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT'
     or (new.cadence, new.hour, new.minute, new.dow, new.tz, new.source_id, new.source_object)
        is distinct from (old.cadence, old.hour, old.minute, old.dow, old.tz, old.source_id, old.source_object) then
    perform public.audit(new.workspace_id, 'schedule.changed', 'dataset', new.dataset_id,
      jsonb_build_object('cadence', new.cadence, 'hour', new.hour, 'minute', new.minute, 'dow', new.dow, 'tz', new.tz,
                         'source_id', new.source_id, 'source_object', new.source_object));
  end if;
  return new;
end $$;
create trigger audit_schedules after insert or update on public.schedules
  for each row execute function public.trg_audit_schedule();

create or replace function public.trg_audit_exception()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.workspace_id, 'exception.opened', 'exception', new.id,
      jsonb_build_object('kind', new.kind, 'severity', new.severity, 'status', new.status));
  elsif tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'exception.deleted', 'exception', old.id, '{}'::jsonb);
    return old;
  else
    if new.status is distinct from old.status then
      perform public.audit(new.workspace_id, 'exception.status', 'exception', new.id,
        jsonb_build_object('from', old.status, 'to', new.status, 'reason', new.waive_reason));
    end if;
    if new.owner is distinct from old.owner then
      perform public.audit(new.workspace_id, 'exception.owner', 'exception', new.id,
        jsonb_build_object('from', old.owner, 'to', new.owner));
    end if;
  end if;
  return new;
end $$;
create trigger audit_exceptions after insert or update or delete on public.exceptions
  for each row execute function public.trg_audit_exception();

create or replace function public.trg_audit_source()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit(new.workspace_id, 'source.added', 'source', new.id::text, jsonb_build_object('kind', new.kind, 'name', new.name));
  elsif tg_op = 'DELETE' then
    perform public.audit(old.workspace_id, 'source.deleted', 'source', old.id::text, jsonb_build_object('kind', old.kind, 'name', old.name));
    return old;
  end if;
  return new;
end $$;
create trigger audit_sources after insert or delete on public.sources
  for each row execute function public.trg_audit_source();

-- ---------------------------------------------------------------- row-level security
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.sources           enable row level security;
alter table public.source_secrets    enable row level security;   -- no policies: service role only
alter table public.datasets          enable row level security;
alter table public.rule_sets         enable row level security;
alter table public.schedules         enable row level security;
alter table public.runs              enable row level security;
alter table public.rule_results      enable row level security;
alter table public.exceptions        enable row level security;
alter table public.workspace_meta    enable row level security;
alter table public.audit_log         enable row level security;

create policy ws_select on public.workspaces for select to authenticated using (public.is_member(id));
create policy ws_update on public.workspaces for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));

create policy wm_select on public.workspace_members for select to authenticated using (public.is_member(workspace_id));
create policy wm_admin_insert on public.workspace_members for insert to authenticated with check (public.is_admin(workspace_id));
create policy wm_admin_update on public.workspace_members for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy wm_admin_delete on public.workspace_members for delete to authenticated using (public.is_admin(workspace_id));

create policy src_select on public.sources for select to authenticated using (public.is_member(workspace_id));
create policy src_insert on public.sources for insert to authenticated with check (public.is_admin(workspace_id));
create policy src_update on public.sources for update to authenticated using (public.is_admin(workspace_id)) with check (public.is_admin(workspace_id));
create policy src_delete on public.sources for delete to authenticated using (public.is_admin(workspace_id));

-- Same four policies for each workspace-scoped table: members read, writers change.
do $$
declare t text;
begin
  foreach t in array array['datasets', 'rule_sets', 'schedules', 'runs', 'rule_results', 'exceptions', 'workspace_meta'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_member(workspace_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (public.can_write(workspace_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id))', t);
    execute format('create policy %1$s_delete on public.%1$I for delete to authenticated using (public.can_write(workspace_id))', t);
  end loop;
end $$;

create policy audit_select on public.audit_log for select to authenticated using (public.is_member(workspace_id));

-- Nothing for anonymous visitors.
revoke all on all tables in schema public from anon;

-- updated_at bookkeeping
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
do $$
declare t text;
begin
  foreach t in array array['sources', 'datasets', 'schedules', 'exceptions', 'workspace_meta'] loop
    execute format('create trigger touch_%1$s before update on public.%1$I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
