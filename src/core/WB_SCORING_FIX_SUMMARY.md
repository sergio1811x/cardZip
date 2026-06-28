# CardZip WB scoring fix

Что сделано:

1. Внедрён строгий evidence-based scoring для WB-кандидатов:
   - direct analog только от 85+;
   - hard reject gates;
   - required semantic groups;
   - отдельные object/title/attribute/visual/query/commercial scores;
   - broad category не может стать direct без сильного visual/attribute доказательства;
   - cross-border не допускается в экономику.

2. Добавлен `wbMatchEngine.ts`:
   - строит market snapshot;
   - считает медиану только по direct local analogs 85+;
   - подтверждает рынок только при 3+ прямых аналогах;
   - отдаёт diagnostics и причины отклонений.

3. `marketProvider.ts` теперь поддерживает:
   - image search;
   - text search;
   - batch search;
   - сбор единого списка кандидатов;
   - сохранение source/queryHits для последующего scoring.

4. `wbFilter.ts` больше не пропускает карточку по одному случайному слову из фразы.

5. `querySelector.ts` генерирует более сильную query ladder: object + required attributes, subtype, core fallback.

6. `analysisSnapshot.ts` теперь не подтверждает рынок по 1 direct analog: для экономики нужно минимум 3 direct analogs 85+.

7. `economicsCalc.ts` больше не синтезирует цену продажи при отсутствии WB-рынка. ROI/маржа не считаются без подтверждённой WB-цены.

8. `worker.js` и `server.js` теперь отдают `allCards`, `queryHits`, `sourceHits`, `marketType`, `photoRank`, чтобы downstream scorer мог доказывать аналоги.

Проверка:
- `node --check server.js`
- `node --check worker.js`
- TypeScript `transpileModule` для изменённых .ts файлов

Важно:
- Полный `npm run typecheck` нужно прогнать в реальном проекте, потому что в sandbox нет `../types` и всей структуры репозитория.
