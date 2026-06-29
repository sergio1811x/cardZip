# CardZip — no-WB MVP implementation summary

## Что сделано

Перевёл текущую версию в архитектуру, где автоматический WB/Ozon-поиск, прямые аналоги, медиана WB и автоматический ROI больше не являются обязательной частью основного анализа.

Теперь основной продукт — закупочный пакет по ссылке 1688 / Taobao / Tmall:

- Product Intelligence как источник понимания товара;
- SKU normalizer;
- PriceDecision;
- WeightDecision;
- ReadinessDecision 0–100;
- cost-only экономика;
- supplier questions RU/CN;
- buyer brief;
- cargo brief;
- SEO draft;
- infographic brief;
- risk checklist;
- sample recommendation;
- ручной сценарный расчёт по цене пользователя;
- ручной ввод конкурентов как optional-flow.

## Главное изменение поведения

Отсутствие WB-данных больше не должно приводить к safe summary. Если товар распарсен и закупочный пакет создан, пользователь получает полный отчёт и кредит списывается как за полезный результат.

Автоматический ROI больше не выводится как факт. Возможен только сценарный ROI:

- по цене, введённой пользователем;
- по конкурентам, добавленным пользователем вручную;
- с явной маркировкой, что это не подтверждённая рыночная цена.

## Изменённые ключевые файлы

- `src/core/decisionLayer.ts`
- `src/core/messageBuilder.ts`
- `src/core/reportValidator.ts`
- `src/core/economicsCalc.ts`
- `src/core/priceResolver.ts`
- `api/step3-market.ts`
- `api/step4-send.ts`
- `api/step5-qa.ts`
- `src/bot/handlers/detailButtons.ts`
- `src/bot/handlers/last.ts`
- `src/bot/handlers/myAnalyses.ts`
- `src/bot/handlers/manualInputs.ts`
- `src/bot/handlers/supplierConfirm.ts`
- `src/bot/index.ts`
- `src/providers/expertWriter.ts`
- `src/providers/expertQaGate.ts`
- `src/providers/finalSynthesis.ts`
- `src/bot/handlers/start.ts`
- `src/bot/handlers/upgrade.ts`
- `src/bot/handlers/link.ts`

## Новые пользовательские сценарии

### Указать вес

Кнопка `⚖️ Указать вес` сохраняет ручной вес выбранного SKU и пересчитывает закупочный пакет.

### Посчитать по моей цене

Кнопка `💰 Моя цена` принимает цену продажи в рублях и считает сценарную прибыль/ROI с пометкой, что это сценарий по цене пользователя.

### Конкуренты вручную

Кнопка `🔍 Конкуренты вручную` принимает текст со ссылками/ценами конкурентов и использует медиану указанных цен как ручной сценарий.

## Проверки

Проверены изменённые TypeScript-файлы через `typescript.transpileModule` и JS parse после transpile.

`npm run typecheck` в sandbox падает из-за отсутствующих внешних типов/окружения (`telegraf`, Node globals, fetch, process), а не из-за синтаксиса изменённых файлов. В реальном репозитории после `npm install` нужно прогнать:

```bash
npm run typecheck
npm test
npm run build
```

## Что осталось как future module

- автоматический WB/Ozon search;
- парсинг прямых аналогов;
- автоматическая медиана рынка;
- автоматический ROI.

Эти функции можно вернуть как Pro/Beta-модуль, но они больше не должны блокировать основной закупочный пакет.
