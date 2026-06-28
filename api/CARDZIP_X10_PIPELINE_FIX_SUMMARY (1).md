# CardZip /x10 pipeline files — fix summary

Проверены и совместимо исправлены 8 ключевых API-файлов:

- `webhook.ts`
- `step1-elim.ts`
- `step2-ai.ts`
- `step3-market.ts`
- `step4-send.ts`
- `step5-qa.ts`
- `send-results.ts`
- `update-wb-categories.ts`

## Критичные исправления

### 1. `step5-qa.ts`: полный отчёт больше не отправляется при QA BLOCK
Раньше при `qaResult.decision === 'BLOCK'` код всё равно отправлял полный отчёт с дисклеймером. Это ломало главный safety-принцип.

Теперь:

- если нет `AnalysisSnapshot` → safe summary, кредит не списывается;
- если Hard Validator блокирует → safe summary, кредит не списывается;
- если QA Gate недоступен / fallback / skipped → safe summary, кредит не списывается;
- если QA Gate вернул `BLOCK` → safe summary, кредит не списывается;
- если `FIX_REQUIRED` → Auto-Fix → повторный Hard Validator → только потом отправка.

### 2. `step4-send.ts`: кредит больше не списывается до QA
Раньше кредит списывался в step4 до финального Hard Validator / QA / отправки.

Теперь кредит списывается только в `step5-qa.ts` после:

1. `validateReport`,
2. `runHardValidator`,
3. `runQaGate`,
4. optional `runAutoFix`,
5. повторного `runHardValidator`.

Если отчёт заблокирован, кредит не списывается.

### 3. `step4-send.ts`: snapshot теперь строится из реальных данных step2/step3
Раньше `productContext` мог теряться, потому что он лежал в `result_json.productContext`, а не внутри `product`.

Теперь snapshot строится через `src/core/analysisSnapshot` и получает:

- `raw1688`,
- `productContext`,
- supplier/MOQ,
- purchase price,
- weight,
- direct WB analogs,
- market flags,
- economics flags.

### 4. `step3-market.ts`: экономика только от 3+ direct analogs 85%+
Раньше WB economics могла получить median price уже при 1 direct-кандидате.

Теперь:

- direct для экономики: only local WB + `similarity >= 85` + valid price;
- market confirmed: минимум 3 direct local analogs;
- 1–2 direct analogs сохраняются как evidence, но не дают ROI/маржу.

### 5. `step3-market.ts`: LLM Judge больше не может поднять слабый кандидат до direct
Раньше borderline LLM мог присвоить `direct_analog` кандидату с низким score.

Теперь:

- borderline = `70..84`;
- если LLM предлагает direct, но score `<85`, карточка остаётся `similar`;
- final direct bucket дополнительно фильтруется по `similarity >= 85`.

### 6. `step3-market.ts`: лимит WB-запросов удержан в 1–3
- `searchWb()` жёстко режет список до `MAX_WB_QUERIES = 3`;
- repair query запускается только если есть свободный слот до 3;
- нельзя случайно уйти в 4–5+ запросов.

### 7. `step1-elim.ts`: убран мёртвый cache block с undefined-переменными
В unreachable-блоке были `cacheKey` / `cachedProduct`, которые могли сломать pipeline, если кэш снова включить.

Теперь кэш явно отключён без опасного dead code.

### 8. `step1-elim.ts`: SKU-кнопки безопаснее
Китайские символы из SKU label чистятся перед показом в Telegram-кнопке. Если после чистки пусто — используется `Вариант N`.

### 9. `step2-ai.ts`: fallback при падении canonicalizer
Если `canonicalizeProduct()` вернул `null`, step3 всё равно получает fallback query/structure/queryPlan/productLexicon и не уходит в пустой WB-search.

### 10. Chaining между шагами теперь проверяет HTTP status
Раньше `fetch()` считался успешным даже при HTTP 500.

Теперь step1→step2, step2→step3, step3→step4, step4→step5 проверяют `response.ok`.

### 11. `webhook.ts`: если step1 не стартовал, job не висит молча
Если step1 не удалось вызвать:

- job переводится в `failed`,
- processing lock снимается,
- пользователь получает сообщение о перегрузе.

### 12. `update-wb-categories.ts`: закрыта security-дыра
Раньше если `TELEGRAM_WEBHOOK_SECRET` не задан, endpoint мог пройти без секрета.

Теперь:

- только `POST`,
- secret обязателен,
- можно использовать `WB_CATEGORIES_UPDATE_SECRET`, fallback на `TELEGRAM_WEBHOOK_SECRET`.

### 13. `send-results.ts`: legacy sender не обходит step5
Если job уже содержит `result.product`, legacy `send-results` делегирует отправку в `/api/step5-qa`, чтобы не обходить Hard Validator / QA Gate.

Также исправлен runtime bug: `verdict` был undefined, теперь используется `conclusion`.

## Проверка

Проверено локально в sandbox:

- TypeScript parse diagnostics: OK;
- `typescript.transpileModule`: OK;
- JS parse after transpile: OK.

Полный `npm run typecheck` нужно прогнать в настоящем проекте, потому что в sandbox нет полной структуры `src`, `types`, package scripts и реальных зависимостей.
