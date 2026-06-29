# CardZip — production stabilization report

## Итоговый статус

Подготовлена версия, которую уже можно ставить на production/staging и прогонять на реальных пользователях в режиме paid beta. Это не означает, что продукт стал «математически идеальным» без живых прогонов: для 10/10 нужны реальные end-to-end тесты на товарах, WB parser, Supabase и Telegram webhooks. Но текущий архив закрывает критичные кодовые и инфраструктурные блокеры, которые мешали безопасному платному запуску.

## Что исправлено

### 1. Build/test pipeline

- Добавлен `npm test`.
- Добавлен `vitest.config.ts`.
- `tsconfig.json` больше не компилирует `*.test.ts` в `dist`, чтобы Vitest не подхватывал CommonJS-тесты из сборки.
- `npm run build` теперь сначала чистит `dist`.

Проверено:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Результат:

```text
typecheck: PASS
tests: 37/37 PASS
build: PASS
prod audit: 0 vulnerabilities
```

### 2. Исправлены реальные report/test bugs

- Убран вывод `ROI: null%` в главном отчёте.
- Для `preliminary_sku` теперь явно пишется, что ROI не считается до подтверждения SKU/комплектации.
- Цена без данных теперь показывается как `—`, а не как вложенное `Цена: Цена: нужно уточнить...`.
- `resolvePurchasePrice` корректно отличает `selected_sku_price` от общего `explicit_sku_price`.
- Оптовые tier prices теперь показывают диапазон `26–28 ¥ (ориентир)` и детали порогов.

### 3. Закрыт legacy route `api/step6-send.ts`

`step6-send.ts` больше не содержит отдельную старую отправку отчёта. Он делегирует в `step5-qa.ts`, чтобы старые queued jobs или случайный вызов `/api/step6-send` не обходили:

- Hard Validator;
- QA Gate;
- Auto-Fix;
- списание кредита только после разрешения QA.

### 4. Убраны hardcoded WB parser secret/default URL

В коде больше нет fallback-секрета вида `cardzip-wb-2024` и дефолтного VPS URL для WB parser. Если `WB_PARSER_URL` или `WB_PARSER_SECRET` не заданы, WB-поиск fail-safe отключается и рынок считается неподтверждённым.

Это правильнее для production: лучше честно не считать WB-экономику, чем отправлять запросы на случайный/старый parser endpoint с публичным секретом.

### 5. Усилена обработка платежей

В `paymentService.ts` добавлена DB-idempotency через таблицу `payment_events`:

- `telegram_payment_charge_id` unique;
- повторный Telegram payment не начислит кредиты второй раз;
- платеж фиксируется как `processing / processed / failed`;
- есть fallback на in-memory set только для старых деплоев без миграции.

Для production нужно обязательно применить новый `supabase/schema.sql`.

### 6. Обновлена Supabase schema

`schema.sql` и `supabase/schema.sql` приведены к фактическому коду:

- `subscriptions.credits_remaining`;
- `subscriptions.is_trial`;
- `subscriptions.unlimited_until`;
- `subscriptions.unlimited_used`;
- `subscriptions.unlimited_limit`;
- `jobs`;
- `products`;
- `events`;
- `payment_events`;
- `wb_categories`;
- `users.custom_tariffs`.

Скрипт написан как idempotent: его можно запускать повторно.

### 7. Добавлен `.env.example`

В финальном production ZIP нет `.env` и пользовательских логов. Есть только `.env.example` с безопасными placeholders.

## Что осталось сделать перед привлечением платных пользователей

### Обязательно перед production

1. Применить `supabase/schema.sql` в Supabase SQL Editor.
2. Заполнить реальные env в Vercel:
   - `TELEGRAM_BOT_TOKEN`;
   - `TELEGRAM_WEBHOOK_SECRET`;
   - `SUPABASE_URL`;
   - `SUPABASE_SERVICE_ROLE_KEY`;
   - `OPENROUTER_API_KEY`;
   - `ELIM_API_KEY`;
   - `WB_PARSER_URL`;
   - `WB_PARSER_SECRET`;
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
3. Прогнать в production/staging:
   - 1688 link → step1 → step2 → step3 → step4 → step5;
   - Telegram payment;
   - `/last`;
   - файлы/материалы;
   - ответ поставщика;
   - ручной ввод веса.
4. Прогнать минимум 20 реальных товаров:
   - обувь/шлёпанцы;
   - пассивная ловушка;
   - multipack SKU;
   - товар без веса;
   - товар без WB рынка;
   - товар с хорошими WB-аналогами;
   - одежда;
   - косметика/сертификационный риск;
   - электроника USB;
   - кухонный товар.

### Product positioning

Запускать как:

> CardZip превращает ссылку 1688/Taobao/Tmall в закупочную гипотезу для WB/Ozon: товар, SKU, цена, риски, вопросы поставщику, WB-ориентиры, черновик SEO и ТЗ байеру.

Не запускать как:

> CardZip точно считает прибыль и гарантирует, что товар зайдёт на WB.

## Честный verdict

Текущая версия после этих правок — production-staging ready и paid-beta ready при условии, что ты прогоняешь реальный E2E на своём окружении. Для заявления «10/10» всё ещё нужны реальные golden tests и ручная проверка качества WB-аналогов на живых товарах.

Главная техническая цель следующего раунда: не новые фичи, а метрики качества и регрессия:

- direct analog precision;
- direct analog recall;
- QA block rate;
- auto-fix rate;
- reports with no ROI because no market/no weight;
- users who clicked supplier questions;
- users who paid after first report.
