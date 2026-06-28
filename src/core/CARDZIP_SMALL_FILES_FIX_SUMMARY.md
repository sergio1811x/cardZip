# Проверка и правки файлов CardZip

Проверены файлы:

- `cnNormalize.ts`
- `verdict.ts`
- `priceResolver.ts`
- `evidence.ts`
- `supplierQuestions.ts`

## Что было не ок

1. `evidence.ts`
   - мог показывать `undefined ¥`, `0 ¥` или сырой мусор в evidence;
   - `MOQ` мог уходить числом/пустым значением;
   - `content.characteristics` мог упасть, если `characteristics` отсутствует;
   - не было нормальной очистки `null`, `undefined`, `NaN`.

2. `priceResolver.ts`
   - `pricing?.directPriceYuan ?? product.priceYuan` мог потерять валидную цену, если `directPriceYuan = 0`;
   - числа из строк не нормализовались;
   - диапазоны цен не были защищены от мусорных значений;
   - display label мог быть слишком сырым.

3. `verdict.ts`
   - `limited`/`unreliable` WB-аналоги могли привести к слишком сильному зелёному выводу;
   - не было жёсткой привязки к подтверждённому рынку / direct analogs;
   - формулировки были слишком уверенные для слабых WB-данных.

4. `cnNormalize.ts`
   - некоторые китайские claim-слова переводились слишком уверенно: например `防水` → `водонепроницаемый`;
   - это опасно для WB/SEO, потому что превращает claim поставщика в неподтверждённое обещание.

5. `supplierQuestions.ts`
   - fallback всегда спрашивал часть вопросов, даже если данные уже известны;
   - не было HTML escaping для Telegram-format.

## Что исправлено

- Убраны риски `undefined ¥`, `0 ¥`, `NaN`, `null` в пользовательских evidence-блоках.
- `priceResolver` теперь выбирает первый валидный положительный источник цены, а не блокируется нулём.
- `verdict` теперь не даёт зелёный вывод без подтверждённого WB-рынка.
- Weak/limited WB-аналоги теперь дают только жёлтую гипотезу, без ROI-уверенности.
- Китайские claims нормализованы мягко: `заявленная влагозащита`, `заявленная натуральная кожа`, etc.
- `supplierQuestions` получил optional context, чтобы не спрашивать то, что уже известно.
- Добавлен escaping HTML для Telegram-формата вопросов.

## Проверка

Прогнано через TypeScript `transpileModule`:

- `cnNormalize.ts` — ok
- `verdict.ts` — ok
- `priceResolver.ts` — ok
- `evidence.ts` — ok
- `supplierQuestions.ts` — ok

Полный `npm run typecheck` нужно запускать в проекте, потому что sandbox не содержит реальный `../types` и `package.json`.
