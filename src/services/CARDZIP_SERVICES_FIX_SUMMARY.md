# CardZip services check/fix summary

Проверены файлы:

- `userService.ts`
- `analyticsService.ts`
- `paymentService.ts`
- `subscriptionService.ts`

## Итог

Синтаксически файлы были простые, но в текущем виде были production-риски для платежей, кредитов и подписок.

## Что исправлено

### `subscriptionService.ts`

1. Добавлен безопасный парсинг чисел и дат.
2. `getSub` переведён на `maybeSingle()` и больше не молчит на ошибках Supabase.
3. Добавлен `tryConsumeCredit(userId): Promise<boolean>`.
4. `consumeCredit(userId)` теперь не делает молчаливый no-op, если кредитов нет. Если списать нечего — бросает `NO_AVAILABLE_CREDITS`.
5. Списание unlimited/credit стало compare-and-swap style:
   - unlimited списывается только если `unlimited_used` не изменился параллельно;
   - credits списываются только если `credits_remaining` не изменился параллельно;
   - при гонке данные перечитываются и делается ещё одна попытка.
6. `addCredits` защищён от race condition через retry с проверкой текущего `credits_remaining`.
7. `activateUnlimited` теперь продлевает активную подписку от текущей даты окончания, а не обнуляет оставшиеся дни.
8. Входные `amount`, `days`, `limit` нормализуются как положительные integer.

### `paymentService.ts`

1. Валидация платежа усилена:
   - валюта должна быть `XTR`;
   - сумма `total_amount` должна совпадать с выбранным пакетом;
   - `packageId` должен быть известным.
2. `invoice_payload` теперь содержит `{ packageId, v: 1 }`.
3. Добавлен export `handlePreCheckout(ctx)` для безопасной проверки Telegram pre-checkout.
4. Добавлена best-effort защита от повторной обработки одного платежа через `telegram_payment_charge_id` / `provider_payment_charge_id`.
5. `track(..., 'paid')` теперь awaited и пишет charge IDs.
6. При неизвестном/битом платеже кредиты не начисляются автоматически.

Важно: in-memory idempotency защищает от дубля в пределах текущего процесса. Для полной защиты между cold starts лучше добавить отдельную таблицу платежей с unique constraint по `telegram_payment_charge_id`.

### `analyticsService.ts`

1. Добавлена санация payload:
   - ограничение длины строк;
   - замена `NaN/Infinity` на `null`;
   - ограничение глубины и количества ключей;
   - массивы ограничены по длине.
2. Пустой `userId` больше не пишет событие.

### `userService.ts`

1. Добавлена проверка Telegram user id:
   - только positive safe integer.

## Проверка

Прогнано:

```bash
typescript.transpileModule
JS parse after transpile
```

Все 4 файла проходят.

## Важное замечание для интеграции

После замены желательно подключить `handlePreCheckout` в Telegram router/webhook для `pre_checkout_query`.

Примерно:

```ts
bot.on('pre_checkout_query', handlePreCheckout)
```

Если routing не через Telegraf middleware, нужно вызвать аналогичный handler там, где сейчас обрабатываются Telegram updates.
