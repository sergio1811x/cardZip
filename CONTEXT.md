# CardZip — Контекст для продолжения разработки

## Что это
Telegram-бот для селлеров и байеров. Пользователь кидает ссылку на товар с 1688/Taobao — бот анализирует товар, ищет конкурентов на Wildberries, генерирует SEO-контент, считает юнит-экономику, собирает ZIP с фото.

**Бот:** @cardzip_bot
**Репо бота:** https://github.com/sergio1811x/cardZip
**Репо парсера:** https://github.com/sergio1811x/wb-parser-service

---

## Текущая архитектура (job queue + chained functions)

```
Пользователь → Telegram
  ↓
Vercel /api/webhook (10с)
  → создаёт job в Supabase (status=pending)
  → отправляет прогресс-сообщение
  → вызывает step1
  ↓
Vercel /api/step1-elim (60с)
  → Elim API → данные товара (1688/Taobao)
  → сохраняет rawProduct в jobs.result_json (status=elim_done)
  → вызывает step2
  ↓
Vercel /api/step2-process (60с)
  → ПАРАЛЛЕЛЬНО:
    - AI генерация через OpenRouter (DeepSeek/MiMo/Gemini)
    - WB поиск по фото через VPS (Playwright)
    - Курс юаня ЦБ
  → экономика + вердикт
  → сохраняет product в jobs.result_json (status=done)
  → вызывает step3
  ↓
Vercel /api/step3-send (60с)
  → ПАРАЛЛЕЛЬНО: ZIP + SEO текст
  → отправляет 3 сообщения + 2 файла в Telegram
  → status=sent
```

**VPS (Jino, 250₽/мес):**
- Только HTTP-сервер `/search-by-image` (Playwright + Chromium + Xvfb)
- Мобильный viewport (iPhone), stealth plugin
- Тёплый контекст с cookies WB (обновляется каждые 30 мин)
- НЕ может ходить на api.telegram.org, OpenRouter, npmjs.org (хостинг режет HTTPS)
- Может ходить на WB и alicdn (российский трафик)

---

## Ключевые проблемы (текущие)

### 1. WB поиск по фото — находит не те товары
**Статус:** НЕ РЕШЕНО
**Суть:** Playwright на VPS загружает фото в WB, но:
- Иногда кнопка "Найти товар" не находится (модалка crop не появляется или появляется с задержкой)
- Когда кнопка не нажата — WB показывает общую выдачу (не по фото)
- DOM парсер берёт эту общую выдачу и возвращает нерелевантные товары
- Когда кнопка нажата — результаты правильные (проверено)

**Что пробовали:**
- Прямой API (category-detection + search-by-photo + card API) — работает на Vercel, но card API отдаёт 403, и результаты по категории а не по визуальному сходству (cosine: null)
- Playwright десктопный viewport — WB показывает "Почти готово..." (антибот)
- Playwright мобильный viewport — проходит антибот, но модалка crop не всегда появляется
- Retry 3 раза для модалки — добавлено, но upload файла занимает 9с на VPS

**Что нужно:**
- Надёжно ждать и кликать кнопку "Найти товар" в модалке
- Или найти способ через прямой API с правильным visual matching

### 2. Chaining Vercel functions
**Статус:** В РАБОТЕ
**Суть:** Каждый step вызывает следующий через `await fetch` с AbortController (1с abort). Паттерн: `res.json()` → `await fetch(..., { signal })` → `return`.
**Проблема:** Vercel может убить функцию после res.json() до того как fetch уйдёт. Abort 1с помогает — fetch успевает отправить TCP пакет.

### 3. Прогресс-сообщения
**Статус:** СДЕЛАНО
**Суть:** Каждый step показывает 7-10 вращающихся сообщений каждые 6 секунд через `setInterval` + `editMessageText`. Утилита в `src/core/progress.ts`.

---

## Сервисы и доступы

| Сервис | Назначение | URL/Хост |
|--------|-----------|----------|
| Vercel | Хостинг бота (Hobby, бесплатно) | card-zip.vercel.app |
| Supabase | PostgreSQL — users, subscriptions, products, events, jobs | imglpbeldqajqxxcffye.supabase.co |
| Upstash Redis | Rate limiting | holy-camel-98107.upstash.io |
| Elim API | Парсинг 1688/Taobao (200 free req) | openapi.elim.asia |
| OpenRouter | AI через DeepSeek/MiMo/Gemini | openrouter.ai |
| VPS Jino | WB Playwright парсер | 50fc4ca33bd1.vps.myjino.ru (порт 80→3001) |
| Telegram | Bot API | @cardzip_bot |

---

## VPS (Jino)

**SSH:** `ssh -p 49349 root@50fc4ca33bd1.vps.myjino.ru`
**OS:** Ubuntu 22.04, Node.js 22.17.0
**RAM:** 1.5 GB, **Disk:** 10 GB NVMe

**Сервисы systemd:**
- `wb-parser` — HTTP сервер (server.js) на порту 3001
- `wb-worker` — НЕ ИСПОЛЬЗУЕТСЯ (выключен), был job worker

**Структура:**
```
/opt/wb-parser-service/
├── server.js      # Express + Playwright, endpoint /search-by-image, /prices, /health
├── worker.js      # НЕ ИСПОЛЬЗУЕТСЯ
├── package.json
└── node_modules/
```

**Playwright:** Chromium headless=false + Xvfb (виртуальный дисплей)
**Stealth:** playwright-extra + puppeteer-extra-plugin-stealth

---

## Модели AI (OpenRouter)

1. `deepseek/deepseek-v4-flash` — основная ($0.09/$0.18, 915ms)
2. `xiaomi/mimo-v2.5` — fallback ($0.14/$0.28)
3. `google/gemini-2.5-flash-lite-preview-09-2025` — последний рубеж ($0.10/$0.40, 506ms)

Промпт: system message "SEO-копирайтер для WB, отвечай JSON" + подробная инструкция с контекстом (селлер закупает в Китае → продаёт на WB).

---

## База данных (Supabase)

**Таблицы:**
- `users` — tg_id, created_at
- `subscriptions` — plan (free/seller/business), active_until
- `products` — кэш товаров (1688_id, cache_key, data_json)
- `events` — аналитика (event_name, payload)
- `jobs` — очередь задач (status: pending→elim→elim_done→processing→done→sent/failed)

**Счётчик генераций:** считается по events с event_name='generation_done' (FREE_LIMIT=3)

---

## Структура проекта (бот)

```
cardZip/
├── api/
│   ├── webhook.ts        # Telegram webhook → создаёт job → step1
│   ├── step1-elim.ts     # Elim API → rawProduct → step2
│   ├── step2-process.ts  # AI + WB + экономика → product → step3
│   ├── step3-send.ts     # ZIP + отправка в Telegram
│   └── send-results.ts   # Fallback поллер (не используется активно)
├── src/
│   ├── bot/              # Telegraf — команды /start, /upgrade, /last, /admin
│   ├── providers/
│   │   ├── productImporter.ts    # Elim API + URL parsing + short link resolver
│   │   ├── aiContentGenerator.ts # OpenRouter + Zod validation + fallback chain
│   │   └── marketProvider.ts     # VPS /search-by-image proxy
│   ├── core/
│   │   ├── economicsCalc.ts  # Юнит-экономика + курс ЦБ
│   │   ├── verdict.ts        # 🟢🟡🔴 рекомендация
│   │   ├── cnNormalize.ts    # Китайский маркетинг → русский
│   │   ├── messageBuilder.ts # Формат 3 сообщений
│   │   ├── seoFormatter.ts   # wb_seo.txt
│   │   ├── zipBuilder.ts     # ZIP из фото в памяти
│   │   └── progress.ts       # Анимированный прогресс (setInterval)
│   ├── services/             # subscription, analytics, payment, user
│   ├── db/queries/           # users, subscriptions, products, events, jobs
│   └── types/index.ts
├── vercel.json
└── package.json
```

---

## Env-переменные (Vercel)

```
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET=cardzip_0f7f1568-d522-4596-9916-3d62d891f646
TELEGRAM_ADMIN_TG_ID=8111756059
SUPABASE_URL=https://imglpbeldqajqxxcffye.supabase.co
SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
OPENROUTER_API_KEY
ELIM_API_KEY
WB_PARSER_URL=http://50fc4ca33bd1.vps.myjino.ru
WB_PARSER_SECRET=cardzip-wb-2024
CONTENT_MODEL=deepseek/deepseek-v4-flash
FALLBACK_MODEL=xiaomi/mimo-v2.5
SECONDARY_FALLBACK_MODEL=google/gemini-2.5-flash-lite-preview-09-2025
```

---

## Что сделано

- [x] Telegram бот с командами /start, /upgrade, /last, /admin
- [x] Парсинг 1688/Taobao/Tmall через Elim API
- [x] Поддержка коротких ссылок (qr.1688.com)
- [x] AI SEO-генерация (3 модели fallback chain)
- [x] Промпт с контекстом WB-селлера, 5 буллетов, характеристики
- [x] WB поиск по фото через VPS Playwright (работает нестабильно)
- [x] Юнит-экономика с real-time курсом ЦБ
- [x] Вердикт 🟢🟡🔴 по марже, конкуренции, цене
- [x] ZIP фото в памяти (без диска)
- [x] Нормализация китайского маркетинга (踩屎感 → облачная амортизация)
- [x] Rate limiting через Redis
- [x] Подписки и платежи через Telegram Invoice API
- [x] Job queue в Supabase
- [x] Pipeline из 4 chained Vercel functions
- [x] Анимированный прогресс (7-10 сообщений на шаг, каждые 6с)
- [x] Парсинг веса из атрибутов товара
- [x] Кэширование товаров в Supabase

## Что НЕ сделано / не работает

- [ ] WB поиск по фото — нерелевантные результаты (кнопка "Найти товар" не всегда кликается)
- [ ] Supabase таблицы в schema.sql не обновлены (jobs таблица добавлена вручную)
- [ ] Платежи не протестированы (нет TELEGRAM_PAYMENT_PROVIDER_TOKEN)
- [ ] /admin метрики не проверены
- [ ] Batch import (Business план)
- [ ] Compare suppliers

---

## Стоимость инфраструктуры

| Статья | Цена |
|--------|------|
| Vercel Hobby | 0 ₽ |
| Supabase Free | 0 ₽ |
| Upstash Free | 0 ₽ |
| Elim API Free (200 req) | 0 ₽ |
| VPS Jino | 250 ₽/мес |
| OpenRouter (DeepSeek) | ~50-200 ₽/мес |
| **Итого** | **~300-450 ₽/мес** |

---

## Приоритеты

1. **Починить WB поиск по фото** — главная ценность продукта
2. **Стабилизировать pipeline** — chain functions должен работать надёжно
3. **Тестирование** — прогнать 10 разных товаров, проверить все сценарии
4. **Маркетинг** — первые посты, первые юзеры
5. **Платежи** — подключить ЮKassa/Prodamus

## Stop-условие

Прекращать фичи при любом из:
- MRR ≥ 10 000 ₽
- 10 платящих пользователей
- 30 активных пользователей за 7 дней
