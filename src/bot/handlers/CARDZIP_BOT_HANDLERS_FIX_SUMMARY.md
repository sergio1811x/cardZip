# CardZip bot handlers check/fix summary

Проверены файлы:

- `detailButtons.ts`
- `last.ts`
- `link.ts`
- `myAnalyses.ts`
- `quickTariff.ts`
- `rewrite.ts`
- `search1688.ts`
- `skuSelect.ts`
- `start.ts`
- `supplierConfirm.ts`
- `supplierQuestions.ts`
- `tariffs.ts`
- `upgrade.ts`
- `wbLeaders.ts`
- `admin.ts`

## Статус

Синтаксически исходные файлы в целом были живые, но не были production-safe.
Основные проблемы были не в TypeScript-синтаксисе, а в безопасности callback-доступа, обходе нового step-pipeline/QA и слишком уверенном выводе экономики/SEO.

## Главные исправления

### 1. Закрыта утечка чужих jobs через callback

Добавлена проверка `user_id` при чтении/обновлении jobs в:

- `rewrite.ts`
- `search1688.ts`
- `skuSelect.ts`
- `quickTariff.ts`
- `supplierConfirm.ts`
- `wbLeaders.ts`

Теперь callback с чужим `jobId` не должен отдавать данные другого пользователя.

### 2. `link.ts` больше не обходит x10 pipeline

Старый `handleLink` делал весь анализ внутри handler-а и отправлял результат напрямую, обходя step-pipeline, QA Gate и новый send-flow.
Теперь `handleLink` — compatibility shim:

- проверяет лимит;
- создаёт job через `createJob`;
- ставит processing lock;
- запускает `/api/step1-elim`;
- больше не делает legacy AI/WB/economics/send напрямую.

Это важно, чтобы пользователь не увидел отчёт до QA.

### 3. `admin.ts` синхронизирован с `update-wb-categories`

- вызов заменён с `GET` на `POST`;
- если `TELEGRAM_WEBHOOK_SECRET` не задан — обновление блокируется;
- host берётся из env, а не только hardcoded.

### 4. `quickTariff.ts` безопаснее пересчитывает экономику

- добавлена проверка владельца job;
- результат сохраняется обратно в job, чтобы `/last` и карточка не расходились;
- WB median используется только если рынок не помечен как неподтверждённый;
- добавлены пределы значений для быстрого тарифа.

### 5. `supplierConfirm.ts` безопаснее обновляет расчёт

- проверяется владелец job;
- извлечённые данные валидируются по диапазонам;
- строки от поставщика экранируются перед HTML-выводом;
- сообщение больше не обещает "полный расчёт", если WB-рынок не подтверждён;
- WB median не используется, если рынок/аналоги не подтверждены.

### 6. `rewrite.ts` убраны опасные SEO-claims

- переписывание больше не просит модель генерировать fake claims вроде `хит продаж`, `последние штуки`, `лучший`, `водонепроницаемый`, `сертифицированный`;
- результат чистится от banned claims;
- AI-ответ экранируется перед `parse_mode: HTML`.

### 7. `search1688.ts`, `wbLeaders.ts`, `supplierQuestions.ts`

- добавлено экранирование HTML;
- проверяется владелец job;
- вопросы поставщику дедуплицируются и не выводят `undefined/null/NaN`.

### 8. `last.ts` и `myAnalyses.ts`

- ROI/прибыль не показываются, если экономика синтетическая, вес отсутствует или market не подтверждён;
- цена/вес форматируются безопаснее.

### 9. `detailButtons.ts`

- если QA/Hard Validator заблокировали полный отчёт, кнопка файлов не отдаёт полные материалы.

### 10. `start.ts`

- убрана слишком уверенная маркетинговая формулировка с примером ROI;
- добавлен акцент, что ROI не показывается без подтверждённых прямых аналогов WB.

## Проверка

Проверено локально в sandbox:

- TypeScript `transpileModule` для всех 15 файлов: OK
- JS parse после transpile для всех 15 файлов: OK

Полный `npm run typecheck` нужно прогнать в реальном проекте, потому что в sandbox нет всей структуры `src`, зависимостей и реальных типов Supabase/Telegraf проекта.
