# cardZip

Telegram-бот для анализа товаров с 1688.com и подготовки материалов для Wildberries.

## Быстрый старт (7 шагов)

### 1. Клонировать и установить зависимости

```bash
git clone <repo>
cd wb-copilot
npm install
cp .env.example .env
```

### 2. Заполнить .env

```
TELEGRAM_BOT_TOKEN=       # от @BotFather
TELEGRAM_WEBHOOK_SECRET=  # любая случайная строка
TELEGRAM_ADMIN_TG_ID=     # твой tg_id (найди через @userinfobot)
TELEGRAM_PAYMENT_PROVIDER_TOKEN=  # от @BotFather → Payments
SUPABASE_URL=             # из Supabase → Settings → API
SUPABASE_SERVICE_ROLE_KEY=  # НЕ anon key, именно service_role
UPSTASH_REDIS_REST_URL=   # из Upstash → REST API
UPSTASH_REDIS_REST_TOKEN=
OPENROUTER_API_KEY=       # openrouter.ai → Keys
TOPSAPI_KEY=              # topsapi.com → Dashboard
```

### 3. Создать таблицы в Supabase

Открой **Supabase → SQL Editor**, вставь содержимое `schema.sql`, выполни.

### 4. Деплой на Vercel

```bash
npm install -g vercel
vercel --prod
```

Vercel автоматически подхватит `src/api/webhook.ts` как serverless function.

> ⚠️ Нужен **Vercel Pro** ($20/мес) — pipeline может занимать 15–25 сек,
> Hobby-план режет функции на 10 сек.

### 5. Зарегистрировать webhook

```bash
# Замени YOUR_BOT_TOKEN, YOUR_VERCEL_URL, YOUR_WEBHOOK_SECRET
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_VERCEL_URL.vercel.app/api/webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query"]
  }'
```

### 6. Локальная разработка

Для локала используй polling вместо webhook:

```bash
# Создай src/dev.ts
# import 'dotenv/config';
# import { bot } from './bot';
# bot.launch().then(() => console.log('Bot started (polling)'));
# process.once('SIGINT', () => bot.stop('SIGINT'));

npx tsx src/dev.ts
```

### 7. Проверить

Отправь боту `/start`, затем любую ссылку с 1688.com.

---

## Структура проекта

```
src/
├── api/webhook.ts          # Vercel entry point
├── bot/
│   ├── index.ts            # Telegraf bot, все handlers
│   ├── handlers/
│   │   ├── link.ts         # Главный pipeline
│   │   ├── start.ts
│   │   ├── upgrade.ts
│   │   ├── last.ts
│   │   └── admin.ts
│   └── middleware/
│       ├── user.ts
│       └── rateLimit.ts
├── services/               # Бизнес-логика
├── providers/              # Внешние API (заменяемые)
├── core/                   # Чистые функции
├── db/                     # Supabase queries
├── lib/                    # Утилиты
└── types/index.ts          # Все интерфейсы
```

## Тарифы

| Тариф | Цена | Лимит |
|-------|------|-------|
| Free | 0 ₽ | 3 генерации навсегда |
| Seller | 1 490 ₽/мес | Безлимит |
| Business | 2 990 ₽/мес | Безлимит + будущие функции |

## Курс юаня

Обновляй вручную в `src/core/economicsCalc.ts`:

```typescript
const YUAN_TO_RUB = 13.5; // ← менять здесь
```

## Stop-условие

Прекращай добавлять фичи при:
- MRR ≥ 10 000 ₽
- 10 платящих пользователей
- 30 активных пользователей за 7 дней

Только маркетинг и критические баги.
