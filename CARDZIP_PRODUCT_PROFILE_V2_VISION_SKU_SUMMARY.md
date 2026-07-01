# CardZip — ProductProcurementProfile v2 / Vision + Selected SKU patch

Основа: `cardzip_product_profile_full_tz_patch.zip`.

Цель патча: усилить распознавание предмета и убрать остаточные риски, где Product Intelligence видел фото, но не получал полный контекст выбранного SKU, MOQ и поставщика.

## Что изменено

### 1. Product Intelligence теперь получает полный post-SKU контекст

В `api/step2-ai.ts` в `canonicalizeProduct()` теперь передаются:

- `selectedSkuId`
- `selectedSkuName`
- `selectedSkuPriceYuan`
- `selectedSkuImage`
- `normalizedSkuTable`
- `moq`
- `supplierName`
- `supplierType`
- `supplierRating`
- `orders`
- bundle фото для Product Intelligence

Это закрывает риск, когда LLM видит товар, но не знает, какой SKU пользователь выбрал.

### 2. SKU selection сохраняет больше фактов

В `src/bot/handlers/skuSelect.ts` теперь сохраняются:

- `raw.selectedSkuId`
- `raw.selectedSkuName`
- `raw.selectedSkuPriceYuan`
- `raw.selectedSkuImage`
- те же поля в `raw.normalized1688.pricing`

### 3. Image preprocessing усилен

В `src/core/procurementProfile.ts` добавлены:

- `ProductIntelligenceImage`
- `collectProductIntelligenceImages()`
- обновлённый `preprocessMainImageForProductIntelligence()`

Приоритет фото:

1. `selected_sku_image`
2. `main_product_image`
3. `detail_image` / `package_image`

Фото используется только для типа товара, формы и видимых деталей. Цена, MOQ, SKU, вес и остатки остаются только из API/provider-данных.

### 4. Product Canonicalizer стал profile-aware

В `src/providers/productCanonicalizer.ts` обновлён prompt:

- требует `productKindClassifier`
- требует `procurementProfile` draft
- явно запрещает противоречить selected SKU
- объясняет, что `selected_sku_image` важнее main image
- требует классифицировать товар по фото + тексту + SKU/атрибутам

LLM теперь может вернуть `procurementProfile`, который затем используется как draft для финального `ProductProcurementProfile`.

### 5. Добавлен consensus classifier

В `src/core/procurementProfile.ts` добавлены:

- `ProductKindDecision`
- `classifyProductKindConsensus()`
- `detectKindByRules()`
- `normalizeProductKind()`

Логика:

- vision/text LLM hypothesis
- title/context hypothesis
- deterministic rules hypothesis
- final productKind + confidence + disagreement flag

Если классификаторы расходятся, confidence снижается, а профиль остаётся осторожным.

### 6. `ProductProcurementProfile` расширен

Добавлены поля:

- `classifier`
- `intelligenceImages`
- `supplierQuestionsCn`
- `supplierQuestionsCnValid`

### 7. Builders читают AI profile draft, но не угадывают заново

`buildProductProcurementProfile()` теперь берёт из draft:

- `identity.titleForReport`
- `identity.titleForSeo`
- `identity.materials`
- `identity.visibleFeatures`
- `identity.unconfirmedFeatures`
- `procurement.mustAskSupplier`
- `procurement.mustCheckBeforeSample`
- `procurement.mustCheckOnSample`
- `procurement.redFlags`
- `content.seoAllowedClaims`
- `content.seoForbiddenClaims`
- `content.infographicIdeas`

А затем прогоняет через deterministic safeguards/rules.

### 8. SelectedSkuDecision усилен

`makeSelectedSkuDecision()` теперь читает:

- `selectedSku`
- `selectedSkuText`
- `selectedSkuName`
- `normalized1688.pricing.selectedSkuName`
- `selectedSkuPriceYuan`
- `normalized1688.pricing.selectedSkuPriceYuan`

Это снижает риск противоречивого selected SKU в отчёте.

### 9. CN translation синхронизирован между ZIP и UI

В `api/step5-qa.ts` результат RU→CN перевода теперь сохраняется в profile:

- `supplierQuestionsCn`
- `supplierQuestionsCnValid`

После этого `supplier_questions.txt`, экран вопросов и повторное копирование берут один и тот же CN-блок.

### 10. ExpertWriter выключен по умолчанию

В `api/step4-send.ts`:

```ts
CARDZIP_EXPERT_WRITER_MODE=off
```

Если его включить, он всё ещё не должен менять source-of-truth profile. Основной MVP работает от `ProductProcurementProfile`.

## Текущая карта LLM-вызовов

1. `productCanonicalizer.ts` — главный Product Intelligence Vision/Text вызов.
2. `translateSupplierQuestionsRuToCn()` — отдельный RU→CN переводчик вопросов.
3. `runQaGate()` — финальная LLM QA-страховка.
4. `runAutoFix()` — LLM repair только после QA warnings.
5. `supplierConfirm.ts` — извлечение данных из ответа поставщика после анализа.
6. `ExpertWriter` — выключен по умолчанию.

Legacy LLM-модули остаются в кодовой базе для совместимости, но основной MVP path не должен использовать их как источник определения товара.

## Проверка

Проверено в sandbox:

```text
TypeScript transpileModule: PASS
JS parse after transpile: PASS
Checked TS files: 91
Errors: 0
```

Fixture-check:

```text
umbrella: PASS
footwear: PASS
sleep_mask: PASS
mini_washer: PASS
```

Полный `npm run typecheck && npm test && npm run build` нужно прогнать в реальном окружении после `npm install`, потому что sandbox не содержит установленный `node_modules` проекта.
