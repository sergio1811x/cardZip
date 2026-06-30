# CardZip — ProductProcurementProfile full TZ patch

Основа: `cardzip_mvp_cleanup_patch.zip`.

Цель патча: перестроить CardZip вокруг единого `ProductProcurementProfile`, чтобы главный отчёт, вопросы поставщику, buyer brief, cargo brief, sample checklist, SEO и ZIP строились из одного профиля, а не заново угадывали товар в каждом генераторе.

## Что изменено

### 1. Добавлен единый слой ProductProcurementProfile

Новый файл:

- `src/core/procurementProfile.ts`

В нём реализованы:

- `ProductProcurementProfile`
- `SelectedSkuDecision`
- `buildProductProcurementProfile()`
- `ensureProductProcurementProfile()`
- `preprocessMainImageForProductIntelligence()`
- `buildMainReportFromProfile()`
- `buildSupplierQuestionsFromProfile()`
- `buildBuyerBriefFromProfile()`
- `buildCargoBriefFromProfile()`
- `buildSampleChecklistFromProfile()`
- `buildSeoDraftFromProfile()`
- `buildReadmeFromProfile()`
- `validateProfile()`
- `validateMainReport()`
- `validateSupplierQuestions()`
- `validateDocuments()`
- `validateCnQuestions()`
- `translateSupplierQuestionsRuToCn()` strict JSON RU→CN translator with safe deterministic fallback

### 2. Profile сохраняется в pipeline

Обновлены:

- `api/step2-ai.ts`
- `api/step3-market.ts`
- `api/step4-send.ts`
- `api/step5-qa.ts`
- `src/bot/handlers/supplierConfirm.ts`

Теперь profile сохраняется как:

- `result_json.productProcurementProfile`
- `result_json.procurementProfile`
- `product.productProcurementProfile`
- `product.procurementProfile`

### 3. Main image preprocessing

В `step2-ai` добавлен `preprocessMainImageForProductIntelligence()`.

Правило: фото передаётся только для понимания типа товара и видимых деталей. Цена, вес, MOQ и SKU берутся из provider/API данных.

### 4. Product Intelligence prompt уточнён

В `src/providers/productCanonicalizer.ts` prompt уточнён под ProductProcurementProfile-архитектуру:

- остальные генераторы не должны заново угадывать товар;
- фото нельзя использовать для цены/веса/MOQ/SKU;
- productKind должен быть из списка MVP;
- supplier questions должны быть источником для `profile.procurement.mustAskSupplier`.

### 5. Main report строится от profile

`src/core/messageBuilder.ts` теперь строит главный отчёт через `buildMainReportFromProfile()`.

Отчёт больше не зависит от старого разрозненного угадывания категории.

### 6. Все документы ZIP строятся от profile

`src/bot/handlers/detailButtons.ts` теперь использует только profile builders для ZIP:

- `supplier_questions.txt`
- `buyer_brief.md`
- `cargo_brief.md`
- `sample_checklist.md`
- `seo_draft.md`
- `README.txt`
- `photos.zip`

Отдельные `risk_checklist.md`, `sample_plan.md`, `infographic_brief.md` не возвращались в ZIP.

### 7. Supplier questions

Теперь вопросы:

- берутся только из `profile.procurement.mustAskSupplier`;
- dedup;
- limit 8–10;
- CN строится отдельно;
- CN проходит validator;
- если CN invalid — UI показывает RU-only и CN не отдаётся как готовая версия.

### 8. SelectedSkuDecision

Добавлен единый объект:

```ts
type SelectedSkuDecision = {
  selectedSkuText: string | null;
  selectedPriceYuan: number | null;
  reliable: boolean;
  reason: string;
};
```

Если SKU не выбран надёжно, отчёт пишет:

- `Выбранный SKU: не определён`
- цена показывается как диапазон по SKU
- не показываются два противоречивых selected SKU.

### 9. Supplier type mapping

Везде в profile UI:

- `seller` → `продавец`
- `merchant` → `проверенный продавец`
- `factory` → `фабрика`
- `unknown` → `не указан`

### 10. Weight

Если веса нет:

- `Вес: не указан`
- `Карго: нужен вес с упаковкой`

`category default weight` не выводится в пользовательский UI.

### 11. SEO

SEO строится от safe profile fields:

- `titleForSeo`
- `seoAllowedClaims`
- `seoForbiddenClaims`
- `unconfirmedFeatures`
- `useCases`
- `materials`

Raw attributes больше не скармливаются SEO как источник для нового угадывания категории.

SEO validator проверяет:

- dangerous claims;
- ровно 5 буллетов в разделе `## Буллеты`;
- дубли характеристик;
- чужие категории.

### 12. Category-specific rules

Поддержаны productKind:

- `footwear`
- `clothing`
- `towel_kilt`
- `umbrella`
- `sleep_mask`
- `mini_washer`
- `passive_insect_trap`
- `usb_device`
- `small_appliance`
- `kitchen_tool`
- `bag_accessory`
- `generic_product`

## Выполнение 23 пунктов ТЗ

1. Main image preprocessing — выполнено.
2. ProductProcurementProfile — выполнено.
3. Product Intelligence prompt — обновлён.
4. В Product Intelligence передаётся main image + normalized product data — выполнено через canonicalizer input и image preprocessing.
5. ProductProcurementProfile сохраняется в analysis result — выполнено.
6. Main report builder от ProductProcurementProfile — выполнено.
7. Buyer brief builder от ProductProcurementProfile — выполнено.
8. Cargo brief builder от ProductProcurementProfile — выполнено.
9. Sample checklist builder от ProductProcurementProfile — выполнено.
10. SEO builder от ProductProcurementProfile — выполнено.
11. Supplier questions из profile.procurement.mustAskSupplier — выполнено.
12. Dedup вопросов — выполнено.
13. Limit supplier questions 8–10 — выполнено.
14. RU→CN translator — добавлен отдельный translator-layer: OpenRouter strict JSON LLM call + deterministic safe fallback при недоступности API.
15. CN validator — выполнено.
16. Dynamic UI RU/CN vs RU-only — выполнено.
17. validateProfile — выполнено.
18. validateMainReport — выполнено.
19. validateSupplierQuestions — выполнено.
20. validateDocuments — выполнено.
21. repair/remove bad block flow — выполнено в validateDocuments/step5: repair, повторное использование fixedDocs; проблемные category lines удаляются.
22. SelectedSkuDecision — выполнено.
23. Final polish — выполнено: supplier mapping, no category default weight in UI, clean filenames, README, UX check.

## Проверки в sandbox

```text
TypeScript transpileModule for src/api TS files: PASS
JS parse after transpile: PASS
Checked TS files: 91
Errors: 0
```

Fixture check:

```text
umbrella: productKind=umbrella, questions=8, CN valid, supplier=продавец, docErrors=[]
footwear: productKind=footwear, questions=8, CN valid, supplier=фабрика, docErrors=[]
sleep_mask: productKind=sleep_mask, questions=8, CN valid, supplier=проверенный продавец, docErrors=[]
mini_washer: productKind=mini_washer, questions=8, CN valid, supplier=продавец, docErrors=[]
PROFILE_FIXTURE_CHECK: PASS
```

Полный `npm run typecheck && npm test && npm run build` нужно запускать в реальном окружении после `npm install`. В sandbox нет зависимостей проекта (`@vercel/node`, `telegraf`, `@types/node`, etc.), поэтому полный `tsc` ожидаемо падает на missing deps, не на синтаксисе патча.

## Diff

Ключевой diff сохранён в корне архива:

- `cardzip_profile_key_diff.patch`
