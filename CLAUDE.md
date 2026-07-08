# CardZip — рабочие инструкции для Claude Code

## Context management

When starting a new task, do not scan the whole repository by default.
First read:
- CLAUDE.md
- docs/AI_HANDOFF.md if it exists
- files explicitly mentioned in the current task

Before running broad searches, reading large directories, or inspecting unrelated modules, explain why it is necessary and ask for confirmation.

### Инструменты и экономия токенов

- Работай экономно по токенам. Не читай файлы целиком без необходимости.
- Для навигации по коду используй **serena** и **typescript-lsp** — ищи символы, зависимости и точки входа, а не читай файлы полностью. Сначала найди нужный символ/зависимость/точку входа, потом предлагай точечные изменения.
- Подгружай релевантный контекст через **remember**.
- Используй **superpowers**, если скилл подходит для задачи.
- **Context7** используй только когда нужна актуальная документация библиотеки/API.

## 1. Что такое CardZip сейчас

CardZip — Telegram-бот закупочного ассистента для товаров с 1688 / Taobao / Tmall.

Текущий продаваемый MVP:

```text
ссылка 1688 → закупочный пакет
```

Пользователь отправляет ссылку на товар, бот должен вернуть:

1. короткий закупочный отчёт;
2. цену / SKU / MOQ / поставщика;
3. список рисков и недостающих данных;
4. вопросы поставщику;
5. ТЗ байеру;
6. ТЗ карго;
7. чек-лист образца;
8. SEO-черновик WB/Ozon;
9. фото товара;
10. ZIP с понятными файлами.

## 2. Что больше НЕ является ядром продукта

Не строить продукт вокруг WB-аналитики.

Запрещено позиционировать основной MVP как:

- поиск аналогов WB;
- расчёт ROI;
- GO / NO GO по рынку;
- проверка прибыльности товара;
- замена MPStats / Moneyplace / аналитики маркетплейсов.

WB/Ozon могут быть отдельным будущим модулем, но текущий MVP — это закупочный пакет по китайской ссылке.

## 3. Главная проблема текущего кода

Исторически каждый генератор сам заново понимал товар:

```text
raw 1688 data
→ SKU перевод
→ главный отчёт
→ вопросы поставщику
→ buyer brief
→ cargo brief
→ sample checklist
→ SEO
```

Из-за этого появляются ошибки:

- разные выбранные SKU в одном отчёте;
- seller/factory остаётся на английском;
- “медицинские сабо” в SEO;
- “срок годности” у маски для сна;
- “подошва” у техники;
- дубли вопросов;
- китайская версия ломается;
- документы выглядят как шаблон, а не закупочный пакет.

Нужно идти к архитектуре:

```text
Provider raw data
→ NormalizedChinaProduct
→ SKU Normalizer / SKU Translator
→ Main image preprocessing
→ Product Intelligence AI
→ ProductProcurementProfile
→ deterministic builders
→ validators
→ user report + ZIP package
```

Главное правило: после Product Intelligence остальные генераторы не имеют права заново угадывать товар.

## 4. ProductProcurementProfile — единый источник правды

Добавить/поддерживать единый объект:

```ts
export type ProductProcurementProfile = {
  identity: {
    productKind: string;
    categoryType: string;
    subCategoryType?: string;
    titleForReport: string;
    titleForSeo: string;
    shortTitle: string;
    coreObject: string;
    formFactor?: string;
    audience?: string;
    gender?: string;
    season?: string;
    useCases: string[];
    materials: string[];
    visibleFeatures: string[];
    claimedFeatures: string[];
    unconfirmedFeatures: string[];
  };

  sku: {
    skuSummary: string;
    selectedSkuText: string | null;
    selectedSkuReliable: boolean;
    dimensions: string[];
    colors: string[];
    sizes: string[];
    models: string[];
    packageTypes: string[];
    packCounts: number[];
    skuRisk: 'none' | 'low' | 'medium' | 'high';
    skuWarnings: string[];
    normalizedExamples: Array<{
      raw: string;
      normalized: string;
      priceYuan?: number | null;
    }>;
  };

  pricing: {
    displayPriceText: string;
    selectedPriceYuan: number | null;
    minPriceYuan: number | null;
    maxPriceYuan: number | null;
    priceSource: 'selected_sku' | 'sku_range' | 'price_range' | 'direct' | 'missing';
    priceReliable: boolean;
    priceWarnings: string[];
  };

  supplier: {
    displayType: 'продавец' | 'проверенный продавец' | 'фабрика' | 'не указан';
    rating?: number | null;
    orders?: number | null;
    name?: string | null;
  };

  procurement: {
    status: 'needs_supplier_data' | 'ready_for_supplier_questions' | 'ready_for_sample' | 'data_poor';
    verdict: string;
    nextAction: string;
    mustAskSupplier: string[];
    mustCheckBeforeSample: string[];
    mustCheckOnSample: string[];
    redFlags: string[];
  };

  cargo: {
    mustAsk: string[];
    likelySensitiveCargoIssues: string[];
  };

  content: {
    seoAllowedClaims: string[];
    seoForbiddenClaims: string[];
    titleWarnings: string[];
    infographicIdeas: Array<{
      slideTitle: string;
      text: string;
      visual: string;
      warning?: string;
    }>;
  };

  dataQuality: {
    missingCriticalFields: string[];
    contradictions: string[];
    confidence: 'high' | 'medium' | 'low';
    reason: string;
  };
};
```

## 5. ProductKind, которые нужно поддерживать

Минимальный список:

```text
footwear
clothing
towel_kilt
umbrella
sleep_mask
mini_washer
food_warmer
small_appliance
passive_insect_trap
usb_device
kitchen_tool
bag_accessory
generic_product
```

Если productKind известен, вопросы, чек-листы, SEO, buyer brief и cargo brief должны соответствовать именно этому товару.

## 6. Текущие критичные баги

Исправлять в первую очередь:

1. Кнопка `💬 Вопросы поставщику` иногда открывает fallback “Не удалось открыть раздел”.
2. Callback-кнопки должны содержать `analysisId`.
3. Handler должен искать анализ по `analysisId` в storage/database/cache, а не только в session.
4. Кредит списывается только один раз за успешный анализ.
5. В отчёте не должно быть двух разных строк “Осталось”.
6. В отчёте не должно быть `Цена: Выбранный SKU: ...`.
7. В отчёте не должно быть `seller`, `merchant`, `factory`.
8. В отчёте не должно быть category default weight.
9. В русских текстах не должно быть смешанных слов типа `поставщpику`.
10. Документы не должны содержать дубли вопросов и характеристик.

## 7. Callback policy

Все inline-кнопки, относящиеся к конкретному анализу, должны иметь `analysisId`:

```text
supplier_questions:{analysisId}
procurement_package:{analysisId}
product_details:{analysisId}
download_zip:{analysisId}
last_report:{analysisId}
new_product
```

Запрещено строить callback только на текущем session state.

Если analysisId не найден:

```text
⚠️ Не удалось открыть раздел

Анализ не найден в хранилище.
Попробуйте открыть последний отчёт или начните новый товар.
```

Логировать:

```ts
console.error('[callback-analysis-not-found]', {
  userId,
  analysisId,
  callbackData,
  availableSessionKeys,
});
```

## 8. Main report builder

Главный отчёт строится детерминированно, не LLM.

Формат:

```text
📦 {profile.identity.titleForReport}

Источник: 1688
Поставщик: {profile.supplier.displayType} · рейтинг {rating} · заказов {orders}

📌 Товар
• Цена: {profile.pricing.displayPriceText}
• Выбранный SKU: {profile.sku.selectedSkuText || "не определён"}
• MOQ: {moq}
• SKU: {profile.sku.skuSummary}
• Цвета: {profile.sku.colors}
• Размеры/модели: {sizes/models/packageTypes}
• Материал: {materials} — подтвердить
• Вес: {weight || "не указан"}

🟡 Статус: нужны данные поставщика

⚠️ Что уточнить
{first 5 profile.procurement.mustAskSupplier}

💸 Предварительная себестоимость
• Закупка: {priceYuan} ¥ ≈ {priceRub} ₽
• Без карго: ~{costWithoutCargo} ₽
• Карго: нужен вес с упаковкой

📁 Закупочный пакет готов
• вопросы поставщику
• ТЗ байеру
• ТЗ карго
• чек-лист образца
• SEO-черновик
• фото товара

🎯 Вывод
{profile.procurement.verdict}

Что сделать:
1. Нажмите «💬 Вопросы поставщику».
2. Отправьте текст поставщику в чат 1688.
3. Скачайте закупочный пакет.

📦 Осталось: {credits} анализов
```

## 9. Главное меню после отчёта

Оставить только:

```text
💬 Вопросы поставщику
📁 Закупочный пакет
📦 Данные товара
🔄 Новый товар
```

Не возвращать на первый уровень:

- `🚀 Дальнейший план`;
- `📥 Ответ поставщика`;
- `⚖️ Указать вес`;
- `💸 Себестоимость`;
- `⚠️ Риски`;
- `🧪 Образец`.

## 10. Supplier questions

RU-вопросы брать из `profile.procurement.mustAskSupplier`.

Порядок:

1. dedup;
2. limit 8–10;
3. форматирование RU;
4. отдельный RU → CN translator;
5. CN validator;
6. если CN failed — RU-only.

CN validator:

- нет кириллицы;
- нет `file://`;
- нет вложенной нумерации;
- количество CN вопросов = количество RU вопросов;
- не больше 10 вопросов;
- нет смешения языков;
- десятичный разделитель — точка: `12.5 元`.

## 11. ZIP package

ZIP должен содержать:

```text
00_Инструкция.txt
01_Вопросы_поставщику.txt
02_ТЗ_байеру.md
03_ТЗ_карго.md
04_Чеклист_образца.md
05_SEO_черновик.md
06_Фото_товара.zip
```

ZIP должен использовать UTF-8 для имён файлов.

Если UTF-8 ломается, fallback:

```text
00_Instruction.txt
01_Voprosy_postavschiku.txt
02_TZ_bayeru.md
03_TZ_kargo.md
04_Checklist_obrazca.md
05_SEO_chernovik.md
06_Foto_tovara.zip
```

## 12. Документы

Все документы строятся шаблонами от ProductProcurementProfile.

### 02_ТЗ_байеру.md

Разделы:

- Товар;
- Поставщик;
- Что подтвердить у поставщика;
- Что проверить на образце;
- Фото, которые нужно запросить;
- Риски;
- Решение.

### 03_ТЗ_карго.md

Разделы:

- Товар;
- Что запросить для доставки;
- Дополнительно по этому товару;
- Текущий статус;
- Важно.

### 04_Чеклист_образца.md

Объединяет старые risk checklist + sample plan.

Разделы:

- До заказа образца;
- Какой SKU взять;
- Что проверить на образце;
- Что измерить;
- Какие фото сделать;
- Красные флаги;
- Решение после образца.

### 05_SEO_черновик.md

Разделы:

- Название;
- Описание;
- Буллеты — 3–5 (только факты, без филлера; лучше меньше, чем вода);
- Характеристики;
- Ключевые слова;
- Что уточнить перед публикацией;
- Нельзя писать как факт;
- Идеи для инфографики.

## 13. Dangerous claims

Запрещено писать как факт без документов/подтверждения:

```text
медицинский
ортопедический
лечебный
антибактериальный
сертифицированный
гипоаллергенный
безопасный для детей
профессиональный
оригинальный бренд
100% водонепроницаемый
UPF50+
дезинфекция
стерилизация
пищевой силикон
графеновый
защита от перегрева
быстрый нагрев
равномерный нагрев
энергосберегающий
влагозащищённый
```

## 14. ProductKind rules — обязательные акценты

### footwear

Спросить/проверить:

- размерная сетка;
- длина стельки;
- материал верха и подошвы;
- вес пары с упаковкой;
- запах EVA/PU;
- качество литья/декора;
- реальные фото пары и упаковки.

Запрещено добавлять мощность, напряжение, вилку, аккумулятор.

### umbrella

Спросить/проверить:

- вес с упаковкой;
- длина в сложенном виде;
- диаметр купола;
- количество спиц;
- материал купола и спиц;
- механизм: открытие или открытие+закрытие;
- чехол;
- UPF50+ только как заявленное/неподтверждённое.

### sleep_mask

Спросить/проверить:

- материал лицевой и внутренней части;
- 3D-форма;
- затемнение;
- ремешок;
- запах;
- швы;
- комфорт 10–15 минут;
- упаковка.

Запрещено: срок годности, консистенция, подошва, мощность.

### food_warmer / small_appliance

Спросить/проверить:

- напряжение;
- мощность;
- тип вилки;
- совместимость с РФ/ЕАЭС;
- максимальная температура нагрева;
- режимы нагрева;
- защита от перегрева — только если подтверждена;
- инструкция;
- сертификаты/декларации;
- видео работы;
- кабель и маркировка;
- вес и габариты упаковки.

Если SKU содержит `韩规`, `韩国`, `корейский стандарт`, `для Кореи`, это стандарт питания/тип вилки, а не цвет.

## 15. Normalizers

### Supplier type mapping

Показывать пользователю только:

```text
seller → продавец
merchant → проверенный продавец
factory → фабрика
unknown → не указан
```

### Weight

Если веса нет:

```text
Вес: не указан
Карго: нужен вес с упаковкой
```

Не писать category default weight в UI.

### Price

Не писать:

```text
Цена: Выбранный SKU: 98 ¥
```

Писать:

```text
Цена: 98 ¥ ≈ 1 156 ₽
Выбранный SKU: корейский стандарт питания / вилка — 98 ¥
```

### Material

Удалять дубли и опасные claims.

Пример для food_warmer:

```text
Материал: силиконовая панель, нагревательный элемент/покрытие — подтвердить
```

Не писать как факт:

- пищевой силикон;
- графеновый корпус;
- безопасный нагрев.

## 16. Validators

Добавить/поддерживать:

- `validateProfile`;
- `validateMainReport`;
- `validateSupplierQuestions`;
- `validateDocuments`;
- `validateZip`;
- `detectMixedCyrillicLatinInRussianText`;
- `dedupNormalizedList`.

Если validator failed:

1. repair;
2. validate again;
3. если не прошло — удалить проблемный блок;
4. не отправлять битые файлы.

## 17. Bulk — не текущий приоритет

Bulk нужен позже как режим:

```text
30 ссылок → bulk_summary.xlsx + общий ZIP с пакетами по товарам
```

Но сейчас нельзя делать bulk, пока single package не чистый.

Текущий приоритет:

1. callback stability;
2. ProductProcurementProfile;
3. deterministic builders;
4. validators;
5. clean ZIP.

## 18. Команды разработки

```bash
npx tsc --noEmit
npm test
npm run lint
```

Если команды отсутствуют, не придумывать успех. Явно писать, какая команда недоступна.

## 19. Acceptance criteria

Готово, если:

1. Главный отчёт не содержит противоречивый selected SKU.
2. ProductKind определяется через Product Intelligence с фото/данными.
3. Все документы строятся от ProductProcurementProfile.
4. Вопросы поставщику не дублируются.
5. Китайский блок либо валидный, либо скрыт.
6. Интерфейс не обещает RU/CN, если CN нет.
7. SEO не содержит dangerous claims.
8. В файлах нет чужих категорий.
9. seller/factory переведены.
10. Вес без данных = “не указан”.
11. ZIP содержит 6 понятных русских файлов + фото.
12. Один товар можно реально отправить поставщику/байеру/карго без ручной чистки.
13. Кнопки `Вопросы`, `Пакет`, `Данные товара` открываются по `analysisId`.
14. Кредит списывается один раз за успешный анализ.
