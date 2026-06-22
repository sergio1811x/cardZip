-- ============================================================
-- 1688 → WB Copilot: полная схема БД
-- Запускать в Supabase SQL Editor
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  tg_id      bigint unique not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_tg_id on users(tg_id);

-- ------------------------------------------------------------
-- subscriptions
-- ------------------------------------------------------------
create table if not exists subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  plan         text not null default 'free'
                 check (plan in ('free', 'seller', 'business')),
  active_until timestamptz,                 -- null = free / бессрочный
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id)
);

create index if not exists idx_subscriptions_user_id on subscriptions(user_id);

-- автоматически обновляем updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_subscriptions_updated_at on subscriptions;
create trigger trg_subscriptions_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- products (долгосрочный кэш)
-- cache_key = sha256(1688_id || ':' || title_cn || ':' || main_image_url)
-- ------------------------------------------------------------
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete set null,
  "1688_id"   text not null,
  cache_key   text unique not null,
  title_ru    text,
  price_yuan  numeric(10, 2),
  weight_kg   numeric(6, 3),
  data_json   jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_products_cache_key on products(cache_key);
create index if not exists idx_products_1688_id   on products("1688_id");

-- ------------------------------------------------------------
-- events (единственный источник аналитики)
-- ------------------------------------------------------------
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references users(id) on delete set null,
  event_name text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_events_user_id    on events(user_id);
create index if not exists idx_events_event_name on events(event_name);
create index if not exists idx_events_created_at on events(created_at desc);

-- ------------------------------------------------------------
-- generations_count: виртуальный счётчик для free лимита
-- считаем из events чтобы не было рассинхронизации
-- ------------------------------------------------------------
-- Используем это view в subscriptionService:
create or replace view free_generations_used as
  select
    user_id,
    count(*) as count
  from events
  where event_name = 'generation_done'
  group by user_id;

-- ------------------------------------------------------------
-- Полезные аналитические запросы для /admin
-- (не выполнять автоматически — только справка)
-- ------------------------------------------------------------

/*
-- Активные пользователи за 7 дней:
select count(distinct user_id) as dau_7d
from events
where created_at > now() - interval '7 days';

-- Конверсия free → paid:
select
  count(distinct case when e.event_name = 'paid' then e.user_id end)::float /
  nullif(count(distinct u.id), 0) * 100 as conversion_pct
from users u
left join events e on e.user_id = u.id;

-- MRR (примерно):
select
  sum(case when s.plan = 'seller'   then 1490
           when s.plan = 'business' then 2990
           else 0 end) as mrr_rub
from subscriptions s
where s.active_until > now();

-- Топ событий:
select event_name, count(*) as cnt
from events
where created_at > now() - interval '7 days'
group by event_name
order by cnt desc;
*/
