-- ────────────────────────────────────────────────────────────────
-- 1688 → WB Copilot: Supabase SQL Schema
-- Выполнять в Supabase → SQL Editor
-- ────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ─── Users ───────────────────────────────────────────────────────

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  tg_id      bigint unique not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_tg_id on users(tg_id);

-- ─── Subscriptions ───────────────────────────────────────────────

create table if not exists subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  plan         text not null default 'free'
                 check (plan in ('free', 'seller', 'business')),
  active_until timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique(user_id)
);

-- Автообновление updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger subscriptions_updated_at
  before update on subscriptions
  for each row execute function update_updated_at();

-- ─── Products (long-term cache) ───────────────────────────────────

create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete set null,
  "1688_id"   text not null,
  cache_key   text unique not null,
  title_ru    text,
  price_yuan  numeric(10, 2),
  weight_kg   numeric(6, 3),
  data_json   jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists idx_products_cache_key on products(cache_key);
create index if not exists idx_products_1688_id   on products("1688_id");
create index if not exists idx_products_user_id   on products(user_id);
-- Для /last: быстрая выборка последнего товара пользователя
create index if not exists idx_products_user_created
  on products(user_id, created_at desc);

-- ─── Events (единственный источник аналитики) ─────────────────────

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete set null,
  event_name  text not null,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists idx_events_user_id    on events(user_id);
create index if not exists idx_events_event_name on events(event_name);
create index if not exists idx_events_created_at on events(created_at);

-- ─── Вспомогательная RPC для /admin ──────────────────────────────

create or replace function admin_top_users_7d()
returns table(tg_id bigint, cnt bigint)
language sql security definer as $$
  select u.tg_id, count(*) as cnt
  from events e
  join users u on u.id = e.user_id
  where e.event_name = 'generation_done'
    and e.created_at >= now() - interval '7 days'
  group by u.tg_id
  order by cnt desc
  limit 5;
$$;
