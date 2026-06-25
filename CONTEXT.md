# CardZip — Контекст для продолжения разработки

## Что это
Telegram-бот закупочного ассистента для селлеров WB. Пользователь кидает ссылку на товар с 1688/Taobao/Tmall — бот анализирует товар, ищет аналоги на WB через адаптивный 4-pass поиск, считает платформо-зависимую экономику, генерирует SEO-карточку и ТЗ байеру.

**Бот:** @cardzip_bot
**Репо бота:** https://github.com/sergio1811x/cardZip
**Репо парсера:** https://github.com/sergio1811x/wb-parser-service

---

## Текущая архитектура (job queue + chained functions)

```
Пользователь → Telegram
  ↓
webhook (10с) → Redis dedup + rate limit + processing lock
  → step1-elim (60с) → Elim API + кэш-проверка + SKU выбор
  → step2-ai (60с) → SEO генерация + Product Understanding + Query Ladder
  → step3-market (60с) → 4-pass WB поиск + code reranker + LLM judge + экономика
  → step4-send (60с) → 3 сообщения + wb_card.md + buyer_brief.md + photos.zip
```

Каждый step: Redis lock (acquireStepLock) + extendProcessingLock + handleStepError при ошибке.

**VPS (Jino, 250₽/мес):**
- Лёгкий Express (~50MB RAM), без Playwright
- `GET /search-by-text` — proxy к search.wb.ru с throttle 350ms + retry 3x при 429
- `POST /search-batch` — массив запросов последовательно
- Российский IP для доступа к WB API

---

## Решённые проблемы

- WB поиск: переведён с Playwright (нестабильный фото-поиск) на text search через search.wb.ru API (VPS proxy)
- Chaining: fetch до res.json(), retry 2x с 4с timeout, Redis step locks
- Прогресс: эмодзи-бар 🟩⬜ с процентами, 14 шагов, typing action
- Дубли: Redis dedup по update_id + message_id + URL + step locks
- Таймауты: handleStepError на каждом step, auto-cleanup зависших jobs (120с)
- Cross-border: фильтрация по time1 из WB API, отдельная корзина

---

## Сервисы и доступы

| Сервис | Назначение | URL/Хост |
|--------|-----------|----------|
| Vercel | Хостинг бота (Hobby, бесплатно) | card-zip.vercel.app |
| Supabase | PostgreSQL — users, subscriptions, products, events, jobs | imglpbeldqajqxxcffye.supabase.co |
| Upstash Redis | Rate limiting | holy-camel-98107.upstash.io |
| Elim API | Парсинг 1688/Taobao (200 free req) | openapi.elim.asia |
| OpenRouter | AI: Gemini/DeepSeek/Llama | openrouter.ai |
| Fireworks | AI fallback: DeepSeek v4 Flash | api.fireworks.ai |
| VPS Jino | WB text search proxy | 50fc4ca33bd1.vps.myjino.ru:3001 |
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
├── server.js      # Express text-only. /search-by-text, /search-batch, /health
├── package.json
└── node_modules/
```

**Playwright убран.** Только HTTP proxy к search.wb.ru с throttle и retry.

---

## Модели AI

**Поиск/структура:** Gemini Flash Lite → DeepSeek v4 Flash → Llama 4 Scout → Fireworks
**Тексты/SEO:** DeepSeek v4 Flash → Gemini → Llama → Fireworks

Вызовы за 1 анализ: 2-5 (SEO + ProductUnderstanding + expand + repair + judge batch).

---

## База данных (Supabase)

**Таблицы:**
- `users` — tg_id, created_at, custom_tariffs (jsonb)
- `subscriptions` — user_id, credits_remaining, is_trial, unlimited_until/used/limit
- `products` — кэш товаров (1688_id, cache_key, data_json)
- `events` — аналитика (event_name, payload)
- `jobs` — очередь: pending→elim→elim_done→sku_pending→ai_processing→ai_done→market_processing→done→sent/failed, updated_at

**Кредиты:** credits_remaining в subscriptions. При регистрации = 3 (is_trial=true). Покупка складывает кредиты. Кредит списывается в step4 после успешной отправки.

---

## Структура проекта (бот)

```
cardZip/
├── api/
│   ├── webhook.ts        # Telegram webhook → создаёт job → step1
│   ├── step1-elim.ts     # Elim API + кэш + SKU выбор → step2-ai
│   ├── step2-ai.ts       # SEO + Product Understanding + Query Ladder → step3-market
│   ├── step3-market.ts   # 4-pass WB поиск + reranker + LLM judge → step4-send
│   ├── step4-send.ts     # 3 сообщения + файлы → Telegram
│   └── send-results.ts   # Legacy (не используется)
├── src/
│   ├── bot/              # Telegraf — /start, /upgrade, /last, /admin, /tariffs + callbacks
│   ├── providers/
│   │   ├── productImporter.ts      # Elim API + URL parsing + SKU median price
│   │   ├── aiContentGenerator.ts   # SEO: DeepSeek→Gemini→Llama→Fireworks
│   │   ├── productUnderstanding.ts # Поиск: analyzeProduct + queryLadder + repairSearch + judgeBatch
│   │   └── marketProvider.ts       # Legacy (не используется)
│   ├── core/
│   │   ├── economicsCalc.ts    # Платформо-зависимая экономика + макс. цена + 3 бюджета
│   │   ├── verdict.ts          # PlatformConclusion (не Score)
│   │   ├── wbSimilarity.ts     # Code Reranker: direct/similar/category/wrong + local/crossborder
│   │   ├── wbFilter.ts         # IQR фильтрация, медиана/P25/P75
│   │   ├── messageBuilder.ts   # 3 сообщения: msg1(анализ) + msg2(риски+бюджеты) + msg3(лимиты)
│   │   ├── riskFlags.ts        # 11 флагов рисков
│   │   ├── seoFormatter.ts     # wb_card.md — Safe Listing
│   │   ├── orderBrief.ts       # buyer_brief.md — ТЗ байеру
│   │   ├── progress.ts         # 🟩⬜ прогресс-бар с %
│   │   ├── categoryChecklist.ts # Чек-листы по категориям
│   │   ├── evidence.ts         # Маркеры достоверности
│   │   ├── supplierQuestions.ts # Fallback вопросы поставщику
│   │   ├── zipBuilder.ts       # ZIP: 1_main_photo.jpg, 2_detail_1.jpg
│   │   └── cnNormalize.ts      # Нормализация китайского маркетинга
│   ├── services/               # subscription, analytics, payment
│   ├── db/queries/             # users, subscriptions, products, events, jobs, userSettings
│   ├── lib/                    # redis, cache, errors, stepLock, stepError, jobCleanup
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
FALLBACK_MODEL=google/gemini-2.5-flash-lite-preview-09-2025
SECONDARY_FALLBACK_MODEL=meta-llama/llama-4-scout
FIREWORKS_API_KEY
```

---

## Что сделано

- [x] 4-step chained pipeline с Redis locks и error handling
- [x] Парсинг 1688/Taobao/Tmall через Elim API + SKU выбор
- [x] LLM Product Understanding + Dynamic Lexicon + Query Ladder
- [x] 4-pass адаптивный WB поиск (ladder → mining → repair → fallback)
- [x] Code Reranker: direct_analog / similar / category_only / wrong
- [x] Cross-border фильтрация по time1 из WB API
- [x] LLM Judge batch для borderline кандидатов
- [x] Платформо-зависимая экономика (1688=full, Taobao=sample, Tmall=reference)
- [x] 3 сценария P25/медиана/P75 + макс. закупочная цена + 3 бюджета
- [x] Safe Listing SEO промпт + Safe riskFlags
- [x] Telegram Stars оплата: 150⭐/300⭐/500⭐
- [x] credits_remaining + is_trial + unlimited_until
- [x] Прогресс-бар 🟩⬜ + typing action
- [x] Redis dedup + rate limits + processing lock + step locks
- [x] handleStepError + jobCleanup (120с timeout)
- [x] Подтверждение от поставщика (extractSupplierData)
- [x] ТЗ байеру (buyer_brief.md) + SEO карточка (wb_card.md)
- [x] Кэширование товаров в Supabase

## Не сделано

- [ ] Поиск по фото (убран, только text search)
- [ ] Batch import нескольких ссылок
- [ ] Сравнение поставщиков
- [ ] История поисковых паттернов (самообучение)
- [ ] Embeddings для товаров

---

## Стоимость инфраструктуры

| Статья | Цена |
|--------|------|
| Vercel Hobby | 0 ₽ |
| Supabase Free | 0 ₽ |
| Upstash Free | 0 ₽ |
| Elim API Free (200 req) | 0 ₽ |
| VPS Jino | 250 ₽/мес |
| OpenRouter (Gemini+DeepSeek) | ~100-300 ₽/мес |
| Fireworks (fallback) | ~50 ₽/мес |
| **Итого** | **~400-600 ₽/мес** |

## Приоритеты

1. **Стабильность** — прогнать 20 товаров, починить все падения
2. **Качество WB поиска** — улучшать адаптивный поиск и reranker
3. **Первые платящие** — маркетинг, первые посты
4. **Обратная связь** — кнопка "аналоги релевантны / нерелевантны"
5. **История паттернов** — самообучение из успешных поисков
