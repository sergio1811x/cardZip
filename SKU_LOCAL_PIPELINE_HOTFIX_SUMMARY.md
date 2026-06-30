# CardZip — SKU Local Pipeline Hotfix

## Что исправлено

Ошибка после выбора SKU:

```text
❌ Не удалось продолжить анализ после выбора SKU. Проверьте APP_URL/INTERNAL_APP_URL и повторите анализ.
```

была вызвана тем, что `skuSelect.ts` запускал следующий шаг через HTTP self-call (`/api/step2-ai`). На Railway это хрупко: если `APP_URL`, `PUBLIC_APP_URL`, порт, домен или старый Vercel URL настроены не идеально, callback выбора SKU обновляет сообщение, но step2 не стартует.

## Новая логика

### 1. Добавлен local in-process pipeline runner

`src/lib/pipelineStep.ts` теперь умеет запускать внутренние шаги pipeline без HTTP-запроса к самому себе:

```text
triggerPipelineStep('/api/step2-ai')
→ local setImmediate
→ import api/step2-ai
→ выполнить handler(req/res mock) в этом же Railway container
```

Это убирает зависимость SKU continuation от `APP_URL` / `INTERNAL_APP_URL`.

### 2. Railway/VPS default теперь local-first

Для Railway/VPS/ Docker без Vercel pipeline по умолчанию идёт через local runner.

HTTP self-call можно включить явно:

```env
PIPELINE_TRIGGER_MODE=detached_http
```

Для твоего single-service Railway лучше:

```env
PIPELINE_TRIGGER_MODE=local
```

### 3. SKU handler больше не падает сразу

Если первый trigger вернул false, job больше не переводится сразу в failed. Вместо этого:

1. loader остаётся живым;
2. watchdog повторяет запуск step2;
3. финальный watchdog делает ещё одну local-попытку;
4. ошибка показывается только если даже local runner не смог запустить step2.

### 4. `.env.example` обновлён

Теперь рекомендуемый режим для Railway:

```env
PIPELINE_TRIGGER_MODE=local
PROCESSING_LOCK_TTL_SEC=900
STEP_LOCK_TTL_SEC=900
JOB_STUCK_TIMEOUT_MS=600000
```

## Изменённые файлы

- `src/lib/pipelineStep.ts`
- `src/bot/handlers/skuSelect.ts`
- `.env.example`

## Проверка

Проверено через TypeScript `transpileModule` для изменённых файлов.

После деплоя проверить сценарий:

1. отправить ссылку с несколькими SKU;
2. выбрать SKU;
3. сообщение должно смениться на loader;
4. в логах должны появиться строки:

```text
[skuSelect] local /api/step2-ai dispatched
[step2-ai] ...
```

а не ошибка про `APP_URL/INTERNAL_APP_URL`.
