-- ============================================================
-- CardZip production schema
-- Safe to run repeatedly in Supabase SQL Editor.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- updated_at trigger helper
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  tg_id bigint unique not null,
  custom_tariffs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table users add column if not exists custom_tariffs jsonb not null default '{}';
create index if not exists idx_users_tg_id on users(tg_id);

-- ------------------------------------------------------------
-- subscriptions / credits
-- ------------------------------------------------------------
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  plan text not null default 'free',
  active_until timestamptz,
  credits_remaining integer not null default 0,
  is_trial boolean not null default false,
  unlimited_until timestamptz,
  unlimited_used integer not null default 0,
  unlimited_limit integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id)
);

alter table subscriptions add column if not exists credits_remaining integer not null default 0;
alter table subscriptions add column if not exists is_trial boolean not null default false;
alter table subscriptions add column if not exists unlimited_until timestamptz;
alter table subscriptions add column if not exists unlimited_used integer not null default 0;
alter table subscriptions add column if not exists unlimited_limit integer not null default 0;
alter table subscriptions add column if not exists active_until timestamptz;
alter table subscriptions add column if not exists plan text not null default 'free';

-- Old schemas had a restrictive plan check. Drop it if present, then add the current one.
alter table subscriptions drop constraint if exists subscriptions_plan_check;
alter table subscriptions add constraint subscriptions_plan_check
  check (plan in ('free', 'pack10', 'pack30', 'week', 'seller', 'business'));

create index if not exists idx_subscriptions_user_id on subscriptions(user_id);
drop trigger if exists trg_subscriptions_updated_at on subscriptions;
create trigger trg_subscriptions_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- jobs: one Telegram analysis pipeline execution
-- ------------------------------------------------------------
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tg_chat_id bigint not null,
  tg_message_id bigint,
  input_url text not null,
  status text not null default 'pending',
  result_json jsonb,
  error text,
  sent_to_telegram boolean not null default false,
  telegram_file_ids jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

alter table jobs add column if not exists tg_message_id bigint;
alter table jobs add column if not exists result_json jsonb;
alter table jobs add column if not exists error text;
alter table jobs add column if not exists sent_to_telegram boolean not null default false;
alter table jobs add column if not exists telegram_file_ids jsonb;
alter table jobs add column if not exists updated_at timestamptz not null default now();
alter table jobs add column if not exists started_at timestamptz;
alter table jobs add column if not exists finished_at timestamptz;

create index if not exists idx_jobs_user_created on jobs(user_id, created_at desc);
create index if not exists idx_jobs_status_created on jobs(status, created_at);
create index if not exists idx_jobs_unsent on jobs(sent_to_telegram, finished_at);
drop trigger if exists trg_jobs_updated_at on jobs;
create trigger trg_jobs_updated_at
  before update on jobs
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- products: long-term cache and /last source
-- ------------------------------------------------------------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  "1688_id" text not null,
  cache_key text unique not null,
  title_ru text,
  price_yuan numeric(10, 2),
  weight_kg numeric(8, 3),
  data_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table products add column if not exists data_json jsonb not null default '{}';
create index if not exists idx_products_cache_key on products(cache_key);
create index if not exists idx_products_1688_id on products("1688_id");
create index if not exists idx_products_user_created on products(user_id, created_at desc);

-- ------------------------------------------------------------
-- events: analytics
-- ------------------------------------------------------------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  event_name text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_events_user_id on events(user_id);
create index if not exists idx_events_event_name on events(event_name);
create index if not exists idx_events_created_at on events(created_at desc);

-- ------------------------------------------------------------
-- payment_events: idempotent Telegram Stars payments
-- ------------------------------------------------------------
create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  telegram_payment_charge_id text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  package_id text not null,
  amount_stars integer not null,
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_payment_events_user_id on payment_events(user_id);
create index if not exists idx_payment_events_created_at on payment_events(created_at desc);

-- ------------------------------------------------------------
-- wb_categories: optional category analytics import
-- ------------------------------------------------------------
create table if not exists wb_categories (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  item text not null,
  sellers integer not null default 0,
  sellers_with_orders integer not null default 0,
  product_cards integer not null default 0,
  product_cards_with_orders integer not null default 0,
  revenue_rub numeric not null default 0,
  average_check_rub numeric not null default 0,
  average_rating numeric not null default 0,
  stock_quantity integer not null default 0,
  redemption_rate numeric not null default 0,
  monopolization_percentage numeric not null default 0,
  turnover_days_per_week numeric not null default 0,
  availability text not null default '',
  parse_date date not null,
  updated_at timestamptz not null default now(),
  unique(item, parse_date)
);

create index if not exists idx_wb_categories_item on wb_categories using gin (to_tsvector('russian', item));
create index if not exists idx_wb_categories_parse_revenue on wb_categories(parse_date desc, revenue_rub desc);

-- ------------------------------------------------------------
-- Admin helper
-- ------------------------------------------------------------
create or replace function admin_top_users_7d()
returns table(tg_id bigint, cnt bigint)
language sql security definer as $$
  select u.tg_id, count(*) as cnt
  from events e
  join users u on u.id = e.user_id
  where e.event_name in ('generation_done', 'sent_link')
    and e.created_at >= now() - interval '7 days'
  group by u.tg_id
  order by cnt desc
  limit 5;
$$;
