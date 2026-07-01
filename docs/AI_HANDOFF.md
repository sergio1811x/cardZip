# AI Handoff — CardZip качество для любых товаров 1688/Taobao/Tmall

> Для полного продуктового ТЗ см. [CLAUDE.md](../CLAUDE.md). Этот файл — только про текущую сессию рефакторинга.

## 1. Цель задачи

Повысить качество закупочного пакета для ЛЮБОГО товара (не только один пример), убрав системные баги:
сломанные кнопки, неверный SKU, общие вопросы поставщику, дублирующиеся материалы/советы, опасные SEO-claims,
шаблонный вид документов. Главное архитектурное правило: **всё строится от одного `ProductProcurementProfile`,
остальные генераторы не имеют права заново угадывать категорию товара**.

Полное ТЗ (27 разделов: profile, productKind rules, callbacks, credits, SEO, briefs, ZIP, validators, тесты)
было дано в чате — в репозитории отдельным файлом не сохранено. Если нужно продолжать по нему систематически,
попроси пользователя вставить текст ТЗ заново или процитировать конкретный раздел (например «раздел 15 SEO»).

## 2. Что уже сделано в этой сессии

Найдено при разведке: архитектура **уже была продвинута** до начала этой сессии — `ProductProcurementProfile`,
детерминированный `buildMainReportFromProfile`, ZIP-билдеры, dedup, credit-line dedup, callback по `jobId`
с поиском в Supabase — всё это уже работало. Ощущение «нестабильности» было не в общей архитектуре,
а в конкретных пробелах ниже.

Исправлено:
- **Корень бага «разные SKU в разных документах»**: экран «Данные товара» (`build1688Detail` в `decisionLayer.ts`)
  брал title/цену/SKU/поставщика из отдельного legacy-контекста (`buildDecisionContext`), а НЕ из
  `ProductProcurementProfile`, как остальные документы. Теперь читает те же поля из профиля.
- `small_appliance` использовал общие (generic) правила без вопросов про напряжение/мощность/тип вилки/сертификаты.
  Добавлена `electricalRules()` и применена к `small_appliance` + двум новым kind: `food_warmer`, `heating_appliance`.
- Добавлены productKind: `food_warmer`, `heating_appliance`, `home_textile`, `beauty_accessory`, `pet_product`, `toy`
  (были в списке ТЗ, отсутствовали в коде).
- Добавлен `plugStandards` в SKU-профиль: маппинг 韩规/欧规/美规/英规/澳规/国标 → Корея/EU/US/UK/AU/CN,
  извлекается из **сырого** (не Chinese-stripped) текста SKU-вариантов.
- Расширена проверка смешанной кириллицы/латиницы: было только `p`→`р`, стало `p c e o a x y k m t H B C`.
  Добавлен экспортируемый `detectMixedCyrillicLatinInRussianText()`.
- Материалы в главном отчёте ограничены 3 (было — весь список).
- Fallback-текст кнопок при `analysisId`/`jobId` не найденном в БД раньше врал «Данные анализа сохранены» —
  теперь честный текст + лог `[callback-analysis-not-found]` с полями `analysisId`, `callbackData`, `availableSessionKeys`.
- Обновлены 2 устаревших теста (`messageBuilder.test.ts`) под текущий формат цены.
- Добавлен `src/core/procurementProfile.test.ts` — 10 тестов на footwear/umbrella/sleep_mask/
  small_appliance/food_warmer/heating_appliance/generic_product/plug-standards/форматирование отчёта.

Также в этой же сессии (до рефакторинга кода) в проект добавлены `.claude/agents/*` и `.claude/skills/*` —
подобранные вручную агенты/skills из внешнего репозитория `github.com/affaan-m/ecc` (typescript-reviewer,
code-reviewer, security-reviewer, build-error-resolver, refactor-cleaner, planner, architect, e2e-runner,
doc-updater + 7 skills). Это НЕ часть продуктового кода, а тулинг для Claude Code самого по себе.

## 3. Изменённые файлы и зачем

| Файл | Зачем |
|---|---|
| `src/core/procurementProfile.ts` | Расширен `ProductKind`, добавлена `electricalRules()`, `plugStandards`, `detectMixedCyrillicLatinInRussianText`, лимит 3 материала в отчёте, verdict для новых kind |
| `src/core/decisionLayer.ts` | `build1688Detail` переведён на чтение из `ProductProcurementProfile` вместо собственного `buildDecisionContext` |
| `src/bot/handlers/detailButtons.ts` | Честный fallback-текст + правильный формат лога при not-found |
| `src/core/messageBuilder.test.ts` | 2 теста обновлены под актуальный формат цены (`Цена: нужно уточнить` вместо `Цена: —`) |
| `src/core/procurementProfile.test.ts` | **Новый файл.** 10 тестов на productKind-специфичные правила |
| `.claude/agents/*`, `.claude/skills/*` | **Новые файлы**, скачаны из внешнего репо (см. п.2) — не продуктовый код |
| `CLAUDE.md`, `CONTEXT.md`, `README.md` | Были помечены как изменённые (`M`) **до начала этой сессии** — я их не трогал. Если diff в них важен, спроси пользователя, что там менялось раньше. |

## 4. Архитектурные решения

- **Единый источник правды** — `ProductProcurementProfile` (`src/core/procurementProfile.ts`). Любой новый экран/документ
  должен читать поля оттуда (`ensureProductProcurementProfile(product)`), а не пересчитывать категорию/SKU/цену заново.
- `decisionLayer.ts` — легаси-модуль с собственной логикой детекции категории (`isUmbrella`, `isSmallAppliance`, ...,
  генераторы SEO-текста). **Не расширять его новой category-специфичной логикой** — это тот самый anti-pattern,
  из-за которого документы расходились. Если нужно что-то похожее — добавлять в `KIND_RULES` в `procurementProfile.ts`.
- `electricalRules(label)` — общий шаблон для товаров с питанием от сети (мощность/напряжение/вилка/сертификаты/видео
  работы/запрет claims про «защиту от перегрева» и т.п.). Переиспользуется для `small_appliance`, `food_warmer`,
  `heating_appliance`. Новый электро-productKind — добавляй через `electricalRules('label')`, не копипасти вручную.
- `plugStandards` извлекается из **сырого** текста SKU (`skuRawText()`), а не из уже очищенного (`skuName()` через
  `safeRu()`, который вырезает китайские иероглифы) — иначе 韩规/欧规 и т.п. никогда не задетектятся.
- `balaclava` не отдельный top-level `ProductKind` — это override внутри `clothing` через `isBalaclavaProduct()` +
  `productSpecificRules()`. Работает корректно, специально не выносил в отдельный kind (не было необходимости).

## 5. Обнаруженные баги / подводные камни

- **`buildMainReport` в `decisionLayer.ts` (строка ~595) — мёртвый код.** Импортируется в `messageBuilder.ts`,
  но нигде не вызывается. Содержит собственную (устаревшую) hardcoded логику "Осталось: N анализов". Не путать
  с активным путём (см. ниже). Кандидат на удаление через `refactor-cleaner` агента, но не трогал — не было в фокусе.
- **Реальный путь credits-строки:** `api/step5-qa.ts` → `applyCreditsLine()` — сначала СТРИПАЕТ старую строку счётчика
  regex'ом, потом добавляет свежую. Это уже защищает от дублирования "Осталось" — не нужно чинить заново,
  можно ошибочно решить, что бага нет, хотя команда просила его починить — он уже был починен раньше.
- `buildMainMessage()` в `messageBuilder.ts` **игнорирует** параметр `status`/`creditsRemaining` — это ожидаемо,
  т.к. кредитная строка добавляется отдельно в `api/step5-qa.ts` после `buildMainMessage`. Если увидишь, что кредиты
  не показываются в тестах `buildMainMessage` — это нормально, не баг.
- `npm run lint` — **скрипта не существует** в `package.json`. Не выдумывай успешный lint-прогон, явно говори,
  что скрипта нет.
- `npx tsc --noEmit` выдаёт заранее существующие (не мои) ошибки `TS6059 rootDir` про файлы в `api/*.ts`
  и одну ошибку `imageUrls` в `detailButtons.ts:136` — все они были ДО этой сессии, я их не трогал и не чинил.
  Не путать с реальными новыми ошибками.
- Файлы `CLAUDE.md`/`CONTEXT.md`/`README.md` уже были в статусе `M` (modified) в самом начале сессии —
  это чужие/старые незакоммиченные правки, не моя работа.

## 6. Запускавшиеся команды

```bash
npx tsc --noEmit        # проверено — новых ошибок в изменённых файлах нет
npx vitest run          # 47/47 тестов зелёные (4 test-файла)
npm run lint            # ⚠️ скрипта "lint" нет в package.json
```

Dev-сервер в этой сессии не запускался (задача была чисто про логику генераторов, не про UI/руки в Telegram).

## 7. Что осталось сделать (по приоритету исходного ТЗ)

Обновлено во **второй сессии** (после первой ревизии этого файла):
1. ✅ `DANGEROUS_CLAIMS` расширен до полного списка раздела 13 ТЗ (добавлены «пищевой силикон», «графеновый»,
   «защита от перегрева», «быстрый нагрев», «равномерный нагрев», «энергосберегающий», «влагозащищённый», «гарантия»).
2. ✅ `home_textile`, `beauty_accessory`, `pet_product`, `toy` получили собственные `KIND_RULES`
   (mustAskSupplier/beforeSample/onSample/cargo/redFlags/seoForbidden/infographic) и собственный verdict
   в `buildKindVerdict` — раньше были на чистом `genericRules()`.
3. ✅ `translateQuestionToCn` расширен под электротовары (напряжение/мощность/тип вилки/сертификаты/видео/маркировка),
   текстиль (состав ткани/усадка/размерная сетка), toy/pet_product (возраст/мелкие детали/животное).
   Также исправлен баг: любой вопрос со словом «фото» ошибочно переводился как зонтичный «чехол» (`/чехол|фото/`
   было одним regex) — теперь разделены.
4. ✅ Найден и исправлен реальный баг в `validateDocuments`: проверка «ровно 5 буллетов SEO» сравнивала
   `doc.filename === 'seo_draft.md'`, а реальное имя файла — `05_SEO_черновик.md` — проверка никогда не срабатывала.
   Заменено на `/seo/i.test(doc.filename)`.
5. ✅ Добавлен `validateZip()` в `procurementProfile.ts` — проверяет, что все 6 обязательных файлов присутствуют
   и не пустые + что фото-запись (`06_Фото_товара.zip` либо fallback-текст) есть. Подключён в
   `handleMaterialsZip` (`detailButtons.ts`) — логирует `[zip-validator]`, если проверка не прошла (не блокирует отправку).
6. ✅ Удалён мёртвый код `buildMainReport` (+ приватная `topQuestions`, использовалась только внутри неё)
   из `decisionLayer.ts` и его импорт из `messageBuilder.ts`.
7. ✅ Добавлены тесты на `towel_kilt` (не называет «мужская юбка-полотенце») и `balaclava`
   (состав ткани/зона дыхания/УФ только как неподтверждённое, без напряжения/вилки).

Обновлено в **третьей сессии** (после разбора бага на товаре «Набор инструментов для дома»):
8. ✅ Централизован price display: `pricing.displayPriceText` больше не содержит слово «Выбранный SKU»
   (баг `Цена: Выбранный SKU: 148 ¥`). Теперь это чистая цена (`148 ¥ ≈ 1 746 ₽` / диапазон / «нужно уточнить»).
   Отдельная строка SKU строится через новую `formatSelectedSkuLine(kind, sku, pricing)` — экспортирована из
   `procurementProfile.ts`, используется в main report, buyer brief, cargo brief и в `decisionLayer.ts` (`build1688Detail`,
   экран «Данные товара»). Для `tool_kit` даёт «набор {N} — состав нужно подтвердить» вместо цены.
9. ✅ Добавлен `productKind = tool_kit` (категория "наборы инструментов") с полным `KIND_RULES`
   (9 вопросов поставщику, before/onSample, cargo, redFlags, seo allowed/forbidden, infographic,
   forbiddenCategoryWords) и своим verdict в `buildKindVerdict`. Раньше такие товары падали в generic/electrical
   fallback, откуда и брались чужие фразы вроде «работоспособность электроинструмента».
10. ✅ SKU normalizer: для `tool_kit` неоднозначные числовые параметры SKU (26/35/102/120/8102 и т.п.) теперь
    подписываются как «комплектация/модель», а не «параметр SKU» (`buildSkuProfile`, `skuWarnings`, главный отчёт).
11. ✅ Material normalizer: добавлен `stripMaterialMarketing()` — убирает маркетинговые прилагательные
    («высококачественная» и т.п.) перед dedup, так что «углеродистая сталь» и «Высококачественная углеродистая
    сталь» больше не дублируются. Общий вывод материала вынесен в `materialsDisplayLine(p)` с суффиксом
    по `MATERIAL_SUFFIX_BY_KIND` (для tool_kit — «подтвердить марку стали и материал ручек»).
12. ✅ SEO: убрана служебная фраза «черновик карточки для WB/Ozon на основе данных 1688» из generic-описания
    (нарушала acceptance criteria) и добавлены tool_kit-специфичные название/описание/буллеты/характеристики.
    `validateDocuments` теперь также ловит и чинит эту фразу и грамматическую ошибку «для ремонт» (без «а»).
13. ✅ `validateMainReport` ловит паттерн `Цена: Выбранный SKU`, `validateSupplierQuestions` проверяет, что
    вопросы про вес всегда содержат «с упаковкой», и что нет висячих кавычек перед номером SKU.
14. ✅ `dedupNormalizedList`/`normalizeDedupKey` получили canonical-ключи для «комплектация» → «точный состав
    комплектации», «материал» (голое слово) → «материал товара», отдельный ключ для «фото раскрытого кейса»
    (чтобы не схлопывался с обычным «фото упаковки»).
15. ✅ `translateQuestionToCn` расширен под tool_kit (кейс/штрихкод/замена при браке) + исправлены два бага
    с русскими словоформами, из-за которых вопросы про образец и про замену при браке проваливались в
    generic-заглушку («请确认该问题中的相关产品信息»): `/образец/` не матчил «образца», `/замена.*брак/` не матчил «замены».
16. ✅ Добавлены тесты на `tool_kit` в `procurementProfile.test.ts` (цена не смешивается с SKU, комплектация/
    модель вместо «параметр SKU», материал без дублей, вопросы с весом+упаковкой, buyer brief без
    electrical-fallback, SEO без служебной фразы и с 5 буллетами).

Ещё не сделано (не в фокусе этой сессии):
- `displayMainSkuSummary` и `buildCostSummaryLines` в `decisionLayer.ts` остаются недостижимым мёртвым кодом
  после удаления `buildMainReport` (сессия 2) — не критично (tsc не ругается, `noUnusedLocals` выключен).
- Полный набор тестов на все 19+1 productKind из ТЗ — сейчас есть footwear/umbrella/sleep_mask/
  small_appliance/food_warmer/heating_appliance/generic_product/towel_kilt/balaclava/tool_kit (10 из 20).
  Не хватает: clothing (без balaclava-override), mini_washer, passive_insect_trap, usb_device, kitchen_tool,
  bag_accessory, home_textile, beauty_accessory, pet_product, toy.
- Не проверялась вживую (реальный Telegram) причина исходной жалобы «кнопка Вопросы поставщику иногда
  ломается» — код в `src/bot/handlers/supplierQuestions.ts` и `src/bot/index.ts` выглядит корректным
  (ищет job по `analysisId` в Supabase, а не только в session), возможные причины остаются гипотезой:
  устаревшая/несовпадающая запись в таблице `jobs` или гонка между сохранением job и показом кнопок.

## 8. Что читать в первую очередь

1. `src/core/procurementProfile.ts` — центральный файл: типы, `KIND_RULES`, все builders/validators. Читать целиком тяжело
   (1100+ строк) — используй `Grep` по конкретной функции, а не читай весь файл.
2. `src/core/procurementProfile.test.ts` — свежие тесты, показывают ожидаемое поведение per-productKind.
3. `CLAUDE.md` в корне — продуктовые acceptance criteria и формат отчёта/ZIP (актуален, хоть и помечен как `M`).
4. `api/step5-qa.ts` — реальная точка финализации job: где именно вызывается `buildMainMessage`, `tryConsumeCredit`,
   `applyCreditsLine`. Если разбираешься с кредитами/финальным сообщением — начинай отсюда, а не с `messageBuilder.ts`.
5. `src/bot/handlers/detailButtons.ts` — все callback-хендлеры кнопок (`jobId`-based), `replySectionError` для fallback.

## 9. Что НЕ сканировать без необходимости

- `node_modules/`, `.next/` (если есть), `dist/`, `build/` — стандартный шум.
- `.claude/agents/`, `.claude/skills/` — сторонние файлы из ecc, не продуктовый код, не имеют отношения к CardZip-логике.
- `api/step1-elim.ts` … `api/step4-send.ts`, `api/webhook.ts`, `api/update-wb-categories.ts` — вызывают
  `rootDir`-нарушающие ошибки tsc (уже сломанный конфиг, не связано с этой задачей) — не пытайся их чинить,
  если не попросили явно.
- `src/providers/` (aiContentGenerator, productImporter, marketProvider и т.п.) — LLM-провайдеры, не трогались
  в этой сессии, не связаны с найденными багами.
- Старые decisionLayer-функции (`buildCargoBrief`, `buildInfographicBrief`, `buildRiskChecklist`,
  `buildSampleRecommendation`) — не трогались, работают независимо от профиля; трогать только если явно попросят
  мигрировать их на профиль.

## 10. Текущий статус git diff

```
 M CLAUDE.md                         (изменено ДО этой сессии, не мной)
 M CONTEXT.md                        (изменено ДО этой сессии, не мной)
 M README.md                         (изменено ДО этой сессии, не мной)
 M src/bot/handlers/detailButtons.ts (эта сессия)
 M src/core/decisionLayer.ts         (эта сессия)
 M src/core/messageBuilder.test.ts   (эта сессия)
 M src/core/procurementProfile.ts    (эта сессия)
?? .claude/agents/                   (эта сессия, тулинг, не продукт)
?? .claude/skills/                   (эта сессия, тулинг, не продукт)
?? src/core/procurementProfile.test.ts (эта сессия, новый тест-файл)
?? docs/AI_HANDOFF.md                (этот файл)
```

Ничего не закоммичено — все изменения находятся в рабочем дереве (working tree).
