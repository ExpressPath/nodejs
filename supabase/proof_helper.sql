-- Proof helper schema
-- Run this SQL in Supabase SQL Editor before enabling Railway helper persistence.

create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.problems (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  language text not null check (language in ('lean', 'coq')),
  file_name text not null default '',
  source_code text not null,
  source_sha256 text not null,
  proof_state text not null check (proof_state in ('YY', 'NY', 'YN', 'NN')),
  verification_status text not null check (verification_status in ('verified', 'failed', 'skipped')),
  verification_result jsonb not null default '{}'::jsonb,
  normalized_format text not null default 'typed-lambda-v1',
  normalized_term jsonb not null,
  adapter_name text not null default '',
  adapter_meta jsonb not null default '{}'::jsonb,
  helper_job_id text,
  request_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.problems add column if not exists title text not null default '';
alter table public.problems add column if not exists language text default 'lean';
alter table public.problems add column if not exists file_name text not null default '';
alter table public.problems add column if not exists source_code text not null default '';
alter table public.problems add column if not exists source_sha256 text not null default '';
alter table public.problems add column if not exists proof_state text;
alter table public.problems add column if not exists verification_status text;
alter table public.problems add column if not exists verification_result jsonb not null default '{}'::jsonb;
alter table public.problems add column if not exists normalized_format text not null default 'typed-lambda-v1';
alter table public.problems add column if not exists normalized_term jsonb;
alter table public.problems add column if not exists adapter_name text not null default '';
alter table public.problems add column if not exists adapter_meta jsonb not null default '{}'::jsonb;
alter table public.problems add column if not exists helper_job_id text;
alter table public.problems add column if not exists request_meta jsonb not null default '{}'::jsonb;
alter table public.problems add column if not exists created_at timestamptz not null default now();
alter table public.problems add column if not exists updated_at timestamptz not null default now();

create table if not exists public.helper_jobs (
  id text primary key,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  title text not null default '',
  language text not null default '',
  file_name text not null default '',
  normalized_format text not null default 'typed-lambda-v1',
  proof_state text,
  verification_status text,
  source_sha256 text,
  result jsonb,
  error jsonb,
  problem_id uuid references public.problems(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.helper_conversion_plans (
  id uuid primary key default gen_random_uuid(),
  helper_job_id text references public.helper_jobs(id) on delete set null,
  operation text not null check (operation in ('convert', 'submit')),
  status text not null check (status in ('queued', 'planning', 'ready', 'running', 'succeeded', 'failed')),
  title text not null default '',
  language text not null check (language in ('lean', 'coq')),
  file_name text not null default '',
  requested_format text not null default 'typed-lambda-v1',
  verify boolean not null default true,
  source_code text not null,
  source_sha256 text not null,
  plan jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  execution_payload jsonb not null default '{}'::jsonb,
  execution_result jsonb,
  execution_error jsonb,
  proof_state text check (proof_state in ('YY', 'NY', 'YN', 'NN')),
  verification_status text check (verification_status in ('verified', 'failed', 'skipped')),
  problem_id uuid references public.problems(id) on delete set null,
  request_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table public.helper_jobs add column if not exists operation text default 'convert';
alter table public.helper_jobs add column if not exists progress jsonb not null default '{}'::jsonb;
alter table public.helper_jobs add column if not exists plan_id uuid;

alter table public.helper_conversion_plans add column if not exists helper_job_id text;
alter table public.helper_conversion_plans add column if not exists operation text default 'convert';
alter table public.helper_conversion_plans add column if not exists status text default 'queued';
alter table public.helper_conversion_plans add column if not exists title text not null default '';
alter table public.helper_conversion_plans add column if not exists language text default 'lean';
alter table public.helper_conversion_plans add column if not exists file_name text not null default '';
alter table public.helper_conversion_plans add column if not exists requested_format text not null default 'typed-lambda-v1';
alter table public.helper_conversion_plans add column if not exists verify boolean not null default true;
alter table public.helper_conversion_plans add column if not exists source_code text not null default '';
alter table public.helper_conversion_plans add column if not exists source_sha256 text not null default '';
alter table public.helper_conversion_plans add column if not exists plan jsonb not null default '{}'::jsonb;
alter table public.helper_conversion_plans add column if not exists progress jsonb not null default '{}'::jsonb;
alter table public.helper_conversion_plans add column if not exists execution_payload jsonb not null default '{}'::jsonb;
alter table public.helper_conversion_plans add column if not exists execution_result jsonb;
alter table public.helper_conversion_plans add column if not exists execution_error jsonb;
alter table public.helper_conversion_plans add column if not exists proof_state text;
alter table public.helper_conversion_plans add column if not exists verification_status text;
alter table public.helper_conversion_plans add column if not exists problem_id uuid;
alter table public.helper_conversion_plans add column if not exists request_meta jsonb not null default '{}'::jsonb;
alter table public.helper_conversion_plans add column if not exists created_at timestamptz not null default now();
alter table public.helper_conversion_plans add column if not exists updated_at timestamptz not null default now();
alter table public.helper_conversion_plans add column if not exists started_at timestamptz;
alter table public.helper_conversion_plans add column if not exists completed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'helper_jobs_plan_id_fkey'
  ) then
    alter table public.helper_jobs
      add constraint helper_jobs_plan_id_fkey
      foreign key (plan_id) references public.helper_conversion_plans(id) on delete set null;
  end if;
end;
$$;

create index if not exists idx_problems_language_created_at
  on public.problems(language, created_at desc);

create index if not exists idx_problems_source_sha256
  on public.problems(source_sha256);

create index if not exists idx_helper_jobs_status_created_at
  on public.helper_jobs(status, created_at desc);

create index if not exists idx_helper_jobs_plan_id
  on public.helper_jobs(plan_id);

create index if not exists idx_helper_conversion_plans_status_created_at
  on public.helper_conversion_plans(status, created_at desc);

create index if not exists idx_helper_conversion_plans_job_id
  on public.helper_conversion_plans(helper_job_id);

drop trigger if exists trg_problems_touch_updated_at on public.problems;
create trigger trg_problems_touch_updated_at
before update on public.problems
for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_helper_jobs_touch_updated_at on public.helper_jobs;
create trigger trg_helper_jobs_touch_updated_at
before update on public.helper_jobs
for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_helper_conversion_plans_touch_updated_at on public.helper_conversion_plans;
create trigger trg_helper_conversion_plans_touch_updated_at
before update on public.helper_conversion_plans
for each row execute procedure public.touch_updated_at();

alter table public.problems enable row level security;
alter table public.helper_jobs enable row level security;
alter table public.helper_conversion_plans enable row level security;

-- No policies are created intentionally.
-- Service role key bypasses RLS; anon/authenticated cannot query these tables.
