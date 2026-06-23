# CardZip — Telegram-бот закупочного ассистента

## Что это
Telegram-бот для селлеров WB. Принимает ссылку на товар с 1688/Taobao/Tmall → выдаёт закупочную карточку: экономику, риски, SEO-материалы, фото, вопросы поставщику.

**Бот:** @cardzip_bot | **Repo:** github.com/sergio1811x/cardZip

## Стек
Node.js · TypeScript · Telegraf · Vercel serverless · Supabase PostgreSQL · Upstash Redis · OpenRouter (DeepSeek) · VPS Playwright (WB парсер)

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
| `step2-ai.ts` | AI генерация SEO (OpenRouter) → seoContent → chains step3-market |
| `step3-market.ts` | WB поиск по фото (VPS) → фильтрация → экономика → conclusion → chains step4 |
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
| `handlers/tariffs.ts` | ⚙️ Мои тарифы — inline редактирование через Redis state |
| `handlers/supplierQuestions.ts` | 📩 Вопросы поставщику — RU/CN из jobs |
| `handlers/quickTariff.ts` | Inline кнопки $3/$4/$5 карго — пересчёт экономики в сообщении |
| `handlers/rewrite.ts` | A/B рерайт SEO (короче/агрессивно/премиум) |
| `handlers/search1688.ts` | 🔎 Найти аналог на 1688 — поисковая ссылка с CN-названием |
| `middleware/user.ts` | Middleware: getOrCreateUser по tg_id |
| `middleware/rateLimit.ts` | Rate limiting через Redis |

### src/core/ — Бизнес-логика
| Файл | Роль |
|------|------|
| `economicsCalc.ts` | Юнит-экономика: платформо-зависимая (1688=full, Taobao=sample, Tmall=reference). Курс ЦБ, smart defaults по категории, ДРР 15%, макс. закупочная цена, 3 бюджета |
| `verdict.ts` | `buildConclusion()` — PlatformConclusion вместо Score. Текстовый вывод по платформе+марже+данным |
| `messageBuilder.ts` | 3 сообщения Telegram: msg1 (анализ+экономика), msg2 (риски+бюджеты+кнопки), msg3 (лимиты) |
| `wbFilter.ts` | IQR фильтрация, keyword matching (фразы→слова), quality assessment, медиана/P25/P75 |
| `riskFlags.ts` | 11 флагов рисков: бренд, электро, дети, вес, поставщик и т.д. |
| `seoFormatter.ts` | seo_content.md — Safe Listing режим, platform banner |
| `orderBrief.ts` | order_brief.md — ТЗ для байера: ссылка, SKU, характеристики, бюджеты, чеклист, CN-сообщение |
| `categoryChecklist.ts` | Категорийные чек-листы: одежда, электроника, текстиль, хрупкое |
| `evidence.ts` | FieldEvidence — маркеры достоверности: confirmed/inferred/unknown |
| `supplierQuestions.ts` | Fallback вопросы поставщику (если LLM не сгенерировал) |
| `zipBuilder.ts` | ZIP в Buffer: 1_main_photo.jpg, 2_detail_1.jpg... |
| `cnNormalize.ts` | Нормализация китайского маркетинга (踩屎感 → облачная амортизация) |
| `progress.ts` | Анимированные прогресс-сообщения (setInterval 5с, 4 шага) |

### src/providers/ — Внешние API
| Файл | Роль |
|------|------|
| `productImporter.ts` | Elim API: парсинг 1688/Taobao/Tmall. Определение платформы, SKU median price, вес из атрибутов |
| `aiContentGenerator.ts` | OpenRouter: 3-model fallback (DeepSeek→MiMo→Gemini). Safe Listing промпт, banned claims, filterKeywords, warnings, supplierQuestions |
| `marketProvider.ts` | VPS Playwright: поиск WB по фото (строго image, без text fallback) |

### src/db/ — Supabase
| Файл | Роль |
|------|------|
| `supabase.ts` | Клиент Supabase |
| `queries/users.ts` | getOrCreateUser |
| `queries/subscriptions.ts` | getStatus, countGenerations (считает по jobs, не events) |
| `queries/products.ts` | Кэш товаров |
| `queries/jobs.ts` | Job queue: pending→elim→elim_done→ai_processing→ai_done→market_processing→done→sent |
| `queries/events.ts` | Analytics events |
| `queries/userSettings.ts` | Custom tariffs: Redis cache (2d TTL) → Supabase |

### src/services/
| Файл | Роль |
|------|------|
| `subscriptionService.ts` | FREE_LIMIT=5, plan free/seller/business, active_until |
| `analyticsService.ts` | track() → events table |
| `paymentService.ts` | Telegram Invoice API |
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

## VPS (Jino) — WB Parser
**SSH:** `ssh -p 49349 root@50fc4ca33bd1.vps.myjino.ru`
**Путь:** `/opt/wb-parser-service/server.js`
**Сервис:** `systemctl restart wb-parser`

Playwright + Chromium + Xvfb. Поиск по фото: upload → модалка crop → "Найти товар" → API intercept. Text fallback через doTextSearch. Возвращает: id, name, brand, price, rating, feedbacks + photoSearchConfirmed.

## Env-переменные
```
TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ADMIN_TG_ID
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
OPENROUTER_API_KEY
ELIM_API_KEY
WB_PARSER_URL, WB_PARSER_SECRET
CONTENT_MODEL, FALLBACK_MODEL, SECONDARY_FALLBACK_MODEL
```

## Жёсткие ограничения
- Только Telegram-бот. Никаких React, Mini Apps, CRM.
- Все файлы в Buffer → Telegram. Никаких файлов на диске Vercel.
- LLM запрещено придумывать характеристики, сертификаты, продажи, цены.
- Score/GO/NO GO убраны. Вместо них — PlatformConclusion.
- Экономика зависит от платформы: 1688=полная, Taobao=образец, Tmall=референс.

## Команды разработки
```bash
npx tsc --noEmit          # проверка типов
git push origin main      # деплой на Vercel (авто)
# VPS:
systemctl restart wb-parser
journalctl -u wb-parser -f
```
