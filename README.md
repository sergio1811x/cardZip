# cardZip

Telegram-бот для анализа товаров с китайских площадок (1688, Taobao) и подготовки материалов для Wildberries.

**Бот:** [@cardzip_bot](https://t.me/cardzip_bot)

---

## Архитектура

```
Telegram → Vercel (webhook) → Pipeline:
                                ├── Elim API (данные товара 1688/Taobao)
                                ├── OpenRouter (role-based AI pipeline)
                                ├── WB Parser VPS (аналитика Wildberries)
                                └── Supabase (БД, кэш)
```

### Role-based AI pipeline

Текущий production pipeline для закупочного пакета строится по схеме:

```text
raw import
→ canonical product context
→ fact sheet
→ capability/category policy
→ gap planner
→ writer
→ qa gate
→ consistency auditor
→ autofix
→ final quality gate
```

Ключевое правило: пользовательские документы больше не должны переугадывать товар отдельно. Они строятся от canonical facts и policy context.

## Сервисы и ссылки

| Сервис | Назначение | URL | Tier |
|--------|-----------|-----|------|
| **Vercel** | Хостинг бота (webhook) | [vercel.com](https://vercel.com) | Hobby (бесплатно) |
| **Supabase** | PostgreSQL — юзеры, подписки, кэш, события | [supabase.com](https://supabase.com) | Free |
| **Upstash Redis** | Rate limiting | [upstash.com](https://upstash.com) | Free |
| **Elim API** | Парсинг товаров 1688 / Taobao / Tmall | [elim.asia](https://elim.asia) | Free (200 req) → $8/мес |
| **OpenRouter** | AI-генерация SEO через DeepSeek / Qwen | [openrouter.ai](https://openrouter.ai) | Pay-per-use |
| **WB Parser (VPS)** | Парсинг Wildberries через Playwright + Chromium | VPS Jino (110 ₽/мес) | Свой сервер |
| **Telegram Bot API** | Интерфейс бота + платежи | [core.telegram.org](https://core.telegram.org/bots/api) | Бесплатно |

## Стоимость инфраструктуры

| Статья | Цена |
|--------|------|
| Vercel Hobby | 0 ₽ |
| Supabase Free | 0 ₽ |
| Upstash Free | 0 ₽ |
| Elim API Free (200 req) | 0 ₽ |
| VPS для WB парсера | 110 ₽/мес |
| OpenRouter (DeepSeek) | ~50-200 ₽/мес |
| **Итого** | **~160-310 ₽/мес** |

## Переменные окружения (.env)

```bash
# Telegram
TELEGRAM_BOT_TOKEN=           # @BotFather → /newbot
TELEGRAM_WEBHOOK_SECRET=      # любая строка для верификации webhook
TELEGRAM_ADMIN_TG_ID=         # твой tg_id (@userinfobot)
TELEGRAM_PAYMENT_PROVIDER_TOKEN=  # @BotFather → Payments (ЮKassa/Prodamus)

# Supabase
SUPABASE_URL=                 # supabase.com → Settings → API → URL
SUPABASE_SERVICE_ROLE_KEY=    # supabase.com → Settings → API → service_role key

# Upstash Redis
UPSTASH_REDIS_REST_URL=       # upstash.com → Redis → REST API
UPSTASH_REDIS_REST_TOKEN=

# OpenRouter (AI)
OPENROUTER_API_KEY=           # openrouter.ai → Keys
CONTENT_MODEL=deepseek/deepseek-v4-flash      # основная модель
FALLBACK_MODEL=deepseek/deepseek-v3.2         # fallback
SECONDARY_FALLBACK_MODEL=qwen/qwen3.5-flash   # вторичный fallback

# Elim API (1688/Taobao)
ELIM_API_KEY=                 # elim.asia → Dashboard → API Keys

# WB Parser (свой VPS)
WB_PARSER_URL=                # http://your-vps-host
WB_PARSER_SECRET=             # секрет для авторизации запросов к парсеру
```

## Быстрый старт

### 1. Клонировать и установить

```bash
git clone https://github.com/sergio1811x/cardZip.git
cd cardZip
npm install
cp .env.example .env
# Заполни .env
```

### 2. Создать таблицы в Supabase

Открой **Supabase → SQL Editor**, вставь содержимое `schema.sql`, выполни.

### 3. Локальная разработка

```bash
npm run dev
```

Бот запустится в polling-режиме (без webhook).

### 4. Деплой на Vercel

```bash
# Через GitHub: подключи репо в Vercel Dashboard
# Build Command: (пустой)
# Output Directory: .
# Добавь все env-переменные
```

### 5. Настроить Telegram webhook

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<VERCEL_URL>/api/webhook&secret_token=<WEBHOOK_SECRET>"
```

### 6. Деплой WB Parser на VPS

```bash
# На VPS (Ubuntu, 1+ GB RAM):
apt-get update && apt-get install -y git xvfb
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20

cd /opt
git clone https://github.com/sergio1811x/wb-parser-service.git
cd wb-parser-service
npm install   # или yarn
npx playwright install --with-deps chromium

# Systemd сервис:
cat > /etc/systemd/system/wb-parser.service << 'EOF'
[Unit]
Description=WB Parser
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/wb-parser-service
ExecStart=/usr/bin/xvfb-run --auto-servernum /usr/bin/node server.js
Restart=always
Environment=PORT=3001
Environment=SECRET=your-secret
[Install]
WantedBy=multi-user.target
EOF

systemctl enable wb-parser && systemctl start wb-parser
```

## Структура проекта

```
cardZip/
├── api/
│   └── webhook.ts              # Vercel serverless entry point
├── src/
│   ├── bot/
│   │   ├── index.ts            # Telegraf — команды, кнопки, роутинг
│   │   ├── handlers/
│   │   │   ├── link.ts         # Главный pipeline (1688 → AI → WB → ZIP)
│   │   │   ├── start.ts        # /start
│   │   │   ├── upgrade.ts      # /upgrade + платежи
│   │   │   ├── last.ts         # /last — история анализов
│   │   │   └── admin.ts        # /admin — метрики
│   │   └── middleware/
│   │       ├── user.ts         # Автосоздание юзера в БД
│   │       └── rateLimit.ts    # Redis rate limiting
│   ├── providers/
│   │   ├── productImporter.ts  # Elim API (1688/Taobao/Tmall)
│   │   ├── aiContentGenerator.ts  # OpenRouter → DeepSeek/Qwen
│   │   └── marketProvider.ts   # WB Parser VPS (Playwright)
│   ├── core/
│   │   ├── economicsCalc.ts    # Юнит-экономика + курс ЦБ
│   │   ├── verdict.ts          # 🟢🟡🔴 рекомендация
│   │   ├── cnNormalize.ts      # Нормализация китайского маркетинга
│   │   ├── messageBuilder.ts   # Формат 3 сообщений Telegram
│   │   ├── seoFormatter.ts     # wb_seo.txt
│   │   └── zipBuilder.ts       # ZIP из фото в памяти
│   ├── services/
│   │   ├── subscriptionService.ts
│   │   ├── analyticsService.ts
│   │   ├── userService.ts
│   │   └── paymentService.ts
│   ├── db/
│   │   ├── supabase.ts
│   │   └── queries/            # users, subscriptions, products, events
│   ├── lib/
│   │   ├── redis.ts
│   │   ├── cache.ts
│   │   └── errors.ts
│   ├── types/index.ts
│   └── dev.ts                  # Локальный запуск (polling)
├── schema.sql                  # Supabase SQL schema
├── vercel.json
├── package.json
└── tsconfig.json

wb-parser-service/              # Отдельный репо, деплоится на VPS
├── server.js                   # Express + Playwright
├── Dockerfile
└── package.json
```

## Pipeline (что происходит при отправке ссылки)

```
1. Юзер кидает ссылку 1688/Taobao
2. Бот распознаёт URL (вкл. короткие qr.1688.com)
3. Проверка лимитов (free: 3 генерации, rate limit)
4. Прогресс: "Шаг 1/4 — Получаю данные..."
5. Elim API → данные товара (цена, фото, характеристики, продавец)
6. Нормализация китайского текста (踩屎感 → облачная амортизация)
7. Прогресс: "Шаг 2/4 — Генерирую SEO..."
8. OpenRouter (DeepSeek) → SEO-текст, 5 буллетов, характеристики
9. Прогресс: "Шаг 3/4 — Анализирую WB..."
10. WB Parser VPS → поиск по фото → цены, карточки, топ-3
11. Юнит-экономика (курс ЦБ real-time)
12. Вердикт: 🟢 Можно тестировать / 🟡 Требует анализа / 🔴 Не рекомендовано
13. Прогресс: "Шаг 4/4 — Собираю материалы..."
14. ZIP с фото + wb_seo.txt (в памяти, без диска)
15. Отправка 3 сообщений в Telegram
16. Логирование в events таблицу
```

## Сообщения бота

**Сообщение 1:** Аналитика — вердикт, данные фабрики, закупка, рынок WB, юнит-экономика

**Сообщение 2:** Файлы — wb_seo.txt (название, описание, 5 буллетов, ключи, характеристики) + images.zip

**Сообщение 3:** Счётчик генераций + кнопки действий

## Тарифы

| Тариф | Цена | Что включено |
|-------|------|-------------|
| Free | 0 ₽ | 3 генерации навсегда |
| Seller | 1 490 ₽/мес | Безлимит + история /last |
| Business | 2 990 ₽/мес | Безлимит + будущие функции |

## Stop-условие

Прекращай добавлять фичи при любом из:
- MRR ≥ 10 000 ₽
- 10 платящих пользователей
- 30 активных пользователей за 7 дней

Только маркетинг и критические баги.
