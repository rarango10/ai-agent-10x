-- Scheduled tasks created by the agent; executed by an external cron hitting /api/cron/execute
create table public.cronjobs (
  id uuid primary key default uuid_generate_v4(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  job_name           text not null,
  description        text not null default '',
  expression         text not null,
  enabled            boolean not null default true,
  last_executed_at   timestamptz,
  next_run_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.cronjobs enable row level security;

create policy "Users can manage own cronjobs"
  on public.cronjobs for all
  using (auth.uid() = user_id);

create index idx_cronjobs_next_run
  on public.cronjobs (next_run_at)
  where enabled = true;
