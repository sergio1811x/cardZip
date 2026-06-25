# CardZip — Telegram-бот закупочного ассистента

## Что это
Telegram-бот для селлеров WB. Принимает ссылку на товар с 1688/Taobao/Tmall → выдаёт закупочную карточку: экономику, риски, SEO-материалы, фото, вопросы поставщику.

**Бот:** @cardzip_bot | **Repo:** github.com/sergio1811x/cardZip

## Стек
Node.js · TypeScript · Telegraf · Vercel serverless · Supabase PostgreSQL · Upstash Redis · OpenRouter (Gemini/DeepSeek/Llama) · Fireworks (fallback) · VPS text search proxy

## Архитектура: 4-step chained pipeline

```
Telegram → webhook (10с) → step1-elim (60с) → step2-ai (60с) → step3-market (60с) → step4-send (60с)
```

Каждый step — отдельная Vercel function. Chain: fetch с 4с abort + 2 retry. Ранний 200 только для URL pipeline. Callbacks/текст — `await bot.handleUpdate()` перед 200.

## Файловая карта

### api/ — Vercel serverless functions
| Файл | Роль |
|------|------|
| `webhook.ts` | Точка входа Telegram. Redis dedup. URL → step1, остальное → bot.handleUpdate |
| `step1-elim.ts` | Парсит товар через Elim API → rawProduct → chains step2-ai |
| `step2-ai.ts` | AI: SEO генерация + Product Understanding + Query Ladder (1 LLM вызов каждый) → chains step3 |
| `step3-market.ts` | 4-pass WB поиск (query ladder → mining → repair → fallback) + code reranker + LLM judge batch → экономика → chains step4 |
| `step4-send.ts` | Собирает ZIP/MD, отправляет 3 сообщения в Telegram |
| `send-results.ts` | Legacy fallback поллер (не используется активно) |

### src/bot/ — Telegraf handlers
| Файл | Роль |
|------|------|
| `index.ts` | Регистрация всех команд и callback handlers |
| `handlers/start.ts` | /start приветствие |
| `handlers/link.ts` | Прямой обработчик ссылок (альтернатива pipeline, с прогрессом) |
| `handlers/upgrade.ts` | /upgrade, оплата через Telegram Invoice API |
| `handlers/last.ts` | /last — последний разбор |
| `handlers/admin.ts` | /admin — метрики |
| `handlers/tariffs.ts` | ⚙️ Расчёт экономики — inline редактирование через Redis state (карго, фулфилмент, налог, маржа, ДРР) |
| `handlers/supplierQuestions.ts` | 📩 Вопросы поставщику — RU/CN из jobs |
| `handlers/quickTariff.ts` | Inline кнопки $3/$4/$5 карго — пересчёт экономики в сообщении |
| `handlers/rewrite.ts` | A/B рерайт SEO (короче/агрессивно/премиум) |
| `handlers/search1688.ts` | 🔎 Найти аналог на 1688 — поисковая ссылка с CN-названием |
| `middleware/user.ts` | Middleware: getOrCreateUser по tg_id |
| `handlers/skuSelect.ts` | Выбор SKU перед расчётом (если 2+ вариантов с разной ценой) |
| `handlers/supplierConfirm.ts` | 📩 Ответ поставщика — LLM извлекает вес/цену/MOQ из текста |
| `handlers/wbLeaders.ts` | 🏆 Лидеры WB — ТОП-10 карточек по отзывам |
| `middleware/rateLimit.ts` | Rate limiting через Redis (ссылки 1/30с, callbacks 5/10с, глобальный 10/мин) |

### src/core/ — Бизнес-логика
| Файл | Роль |
|------|------|
| `economicsCalc.ts` | Юнит-экономика: платформо-зависимая (1688=full, Taobao=sample, Tmall=reference). Курс ЦБ, smart defaults по категории, ДРР 15%, макс. закупочная цена, 3 бюджета |
| `verdict.ts` | `buildConclusion()` — PlatformConclusion вместо Score. Текстовый вывод по платформе+марже+данным |
| `messageBuilder.ts` | 3 сообщения Telegram: msg1 (анализ+экономика), msg2 (риски+бюджеты+кнопки), msg3 (лимиты) |
| `wbFilter.ts` | IQR фильтрация, keyword matching, quality assessment, медиана/P25/P75 |
| `wbSimilarity.ts` | Code Reranker: 4-level matching (direct_analog/similar/category_only/wrong), local vs crossborder, seller dedup |
| `riskFlags.ts` | 11 флагов рисков: бренд, электро, дети, вес, поставщик и т.д. |
| `seoFormatter.ts` | seo_content.md — Safe Listing режим, platform banner |
| `orderBrief.ts` | order_brief.md — ТЗ для байера: ссылка, SKU, характеристики, бюджеты, чеклист, CN-сообщение |
| `categoryChecklist.ts` | Категорийные чек-листы: одежда, электроника, текстиль, хрупкое |
| `evidence.ts` | FieldEvidence — маркеры достоверности: confirmed/inferred/unknown |
| `supplierQuestions.ts` | Fallback вопросы поставщику (если LLM не сгенерировал) |
| `zipBuilder.ts` | ZIP в Buffer: 1_main_photo.jpg, 2_detail_1.jpg... |
| `cnNormalize.ts` | Нормализация китайского маркетинга (踩屎感 → облачная амортизация) |
| `progress.ts` | Прогресс-бар 🟩⬜ с процентами, 14 шагов, typing action |

### src/providers/ — Внешние API
| Файл | Роль |
|------|------|
| `productImporter.ts` | Elim API: парсинг 1688/Taobao/Tmall. Определение платформы, SKU median price, вес из атрибутов |
| `aiContentGenerator.ts` | Тексты: DeepSeek→Gemini→Llama→Fireworks. Safe Listing промпт, banned claims, warnings, supplierQuestions |
| `productUnderstanding.ts` | Поиск: Gemini→DeepSeek→Llama→Fireworks. Product Understanding + Dynamic Lexicon + Query Ladder + Search Repair Agent + LLM Judge batch |
| `marketProvider.ts` | Legacy (не используется, поиск через VPS /search-by-text) |

### src/db/ — Supabase
| Файл | Роль |
|------|------|
| `supabase.ts` | Клиент Supabase |
| `queries/users.ts` | getOrCreateUser + создаёт subscription с 3 trial кредитами |
| `queries/subscriptions.ts` | Legacy (перенесено в subscriptionService) |
| `queries/products.ts` | Кэш товаров |
| `queries/jobs.ts` | Job queue: pending→elim→elim_done→ai_processing→ai_done→market_processing→done→sent |
| `queries/events.ts` | Analytics events |
| `queries/userSettings.ts` | Custom tariffs: Redis cache (2d TTL) → Supabase |

### src/services/
| Файл | Роль |
|------|------|
| `subscriptionService.ts` | credits_remaining + unlimited_until/used/limit. Кредиты складываются, is_trial авто-снимается |
| `analyticsService.ts` | track() → events table |
| `paymentService.ts` | Telegram Stars: 150⭐/300⭐/500⭐. Пакеты 10/30/Pro 7дн |
| `userService.ts` | User utilities |

### src/types/index.ts — Ключевые типы
- `Platform`: '1688' | 'taobao' | 'tmall'
- `RawProduct1688`: всё с парсера (platform, priceYuan, weightKg, skus, priceIsRange)
- `ProductWithContent`: enriched product (seoContent, wbFiltered, economics, budgets, maxPurchasePrice, conclusion, evidence)
- `PlatformConclusion`: {platform, icon, headline, disclaimers[]} — заменяет Score/Verdict
- `EconomicsResult`: {platformMode, breakdown, costRub, grossProfitRub, roiPercent, isSyntheticPrice...}
- `BudgetScenarios`: {sample, test, firstBatch} — 3 бюджета
- `MaxPurchasePrice`: {maxYuan, currentYuan, allowed} — обратный расчёт
- `WbFilteredResult`: {quality, medianPrice, p25/p75, relevantCount, totalFeedbacks}
- `RiskFlags`: 11 булевых флагов
- `UserTariffs`: {cargoPerKgUsd, fulfillmentRub, taxPercent, targetMarginPercent, drrPercent}
- `FieldEvidence`: {field, value, confidence, source}

### src/lib/ — Утилиты
| Файл | Роль |
|------|------|
| `redis.ts` | Upstash Redis клиент |
| `cache.ts` | buildCacheKey для кэша товаров |
| `errors.ts` | AppError с userMessage |
| `stepLock.ts` | Redis NX lock для каждого step + extendProcessingLock |
| `stepError.ts` | Единый error handler: editMessage→ошибка, job→failed, lock→снят |
| `jobCleanup.ts` | Автоочистка зависших jobs (120с timeout) при следующем действии юзера |

## VPS (Jino) — WB Text Search Proxy
**SSH:** `ssh -p 49349 root@50fc4ca33bd1.vps.myjino.ru`
**Путь:** `/opt/wb-parser-service/server.js`
**Сервис:** `systemctl restart wb-parser`

Лёгкий Express (~50MB RAM). Endpoints:
- `GET /search-by-text` — proxy к search.wb.ru с throttling 350ms и retry 3x при 429
- `POST /search-batch` — массив запросов последовательно с throttling
- `GET /health`
Playwright убран. Возвращает: id, name, brand, price, rating, feedbacks, wh, time1, time2, dist, seller.

## Env-переменные
```
TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ADMIN_TG_ID
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
OPENROUTER_API_KEY
ELIM_API_KEY
WB_PARSER_URL, WB_PARSER_SECRET
CONTENT_MODEL, FALLBACK_MODEL, SECONDARY_FALLBACK_MODEL
FIREWORKS_API_KEY
```

## Монетизация
- 3 бесплатных анализа (is_trial=true, credits_remaining=3)
- Telegram Stars: 10 анализов 150⭐, 30 анализов 300⭐, 7 дней Pro 500⭐ (100 лимит)
- Кредиты складываются при покупке, не сгорают
- Безлимит: unlimited_until + unlimited_used + unlimited_limit
- Кредит списывается в step4 после успешной отправки

## Защита
- Redis dedup: update_id (60с) + message_id (120с) + URL (120с)
- Redis step lock: каждый step (120с) через acquireStepLock
- Redis processing lock: 75с TTL, продлевается каждым step через extendProcessingLock
- Rate limit: ссылки 1/30с, callbacks 5/10с, глобальный 10/мин
- WB throttle: 350ms между запросами, retry 3x при 429
- Автоочистка зависших jobs при следующем действии юзера (120с timeout)
- handleStepError: при ошибке любого step → editMessage→ошибка + job→failed + lock→снят

## Модели LLM (роутинг)
- Поиск/структура: Gemini Flash Lite → DeepSeek v4 Flash → Llama 4 Scout → Fireworks
- Тексты/SEO: DeepSeek v4 Flash → Gemini → Llama → Fireworks

## Жёсткие ограничения
- Только Telegram-бот. Никаких React, Mini Apps, CRM.
- Все файлы в Buffer → Telegram. Никаких файлов на диске Vercel.
- LLM запрещено придумывать характеристики, сертификаты, продажи, цены.
- Score/GO/NO GO убраны. Вместо них — PlatformConclusion.
- Экономика зависит от платформы: 1688=полная, Taobao=образец, Tmall=референс.
- Экономика только по directLocalAnalogs. Cross-border и category_only не используются для ROI.
- WB поиск: 4-pass адаптивный (query ladder L1-L5 → mining → repair agent → fallback).

## Команды разработки
```bash
npx tsc --noEmit          # проверка типов
git push origin main      # деплой на Vercel (авто)
# VPS:
systemctl restart wb-parser
journalctl -u wb-parser -f
```
