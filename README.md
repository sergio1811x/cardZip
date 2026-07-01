# CardZip

Telegram-бот закупочного ассистента для товаров с 1688 / Taobao / Tmall.

Пользователь отправляет ссылку на товар, а бот готовит закупочный пакет: краткий отчёт, вопросы поставщику, ТЗ байеру, ТЗ карго, чек-лист образца, SEO-черновик и фото товара.

**Бот:** [@cardzip_bot](https://t.me/cardzip_bot)

## Что делает бот

```text
ссылка 1688 → закупочный пакет
```

На выходе пользователь получает:

- краткий отчёт по товару;
- цену, SKU, MOQ, поставщика;
- список недостающих данных;
- вопросы поставщику;
- ТЗ байеру;
- ТЗ карго;
- чек-лист образца;
- SEO-черновик WB/Ozon;
- фото товара;
- ZIP-пакет.

## Что бот НЕ обещает в текущем MVP

CardZip сейчас не является полноценной WB-аналитикой.

Не обещаем:

- найти аналоги WB;
- посчитать ROI;
- сказать, точно брать товар или нет;
- проверить прибыльность рынка;
- заменить MPStats / Moneyplace / аналитику маркетплейсов.

Текущий фокус — подготовка товара с китайской площадки к закупке.

## Архитектура

Целевая архитектура:

```text
Telegram
→ Vercel webhook
→ Elim API / provider raw data
→ NormalizedChinaProduct
→ SKU normalizer
→ main image preprocessing
→ Product Intelligence AI
→ ProductProcurementProfile
→ deterministic builders
→ validators
→ Telegram report + ZIP package
```

Главный принцип: сначала один раз понять товар через Product Intelligence, затем строить все документы от `ProductProcurementProfile`.

SEO, вопросы поставщику, ТЗ байеру, ТЗ карго и чек-лист не должны заново угадывать категорию товара.

## Основные файлы результата

ZIP-пакет должен содержать:

```text
00_Инструкция.txt
01_Вопросы_поставщику.txt
02_ТЗ_байеру.md
03_ТЗ_карго.md
04_Чеклист_образца.md
05_SEO_черновик.md
06_Фото_товара.zip
```

## Главное меню после отчёта

После анализа показываются только основные действия:

```text
💬 Вопросы поставщику
📁 Закупочный пакет
📦 Данные товара
🔄 Новый товар
```

Не нужно перегружать первый уровень кнопками “себестоимость”, “риски”, “образец”, “ответ поставщика”, “дальнейший план”.

## ProductProcurementProfile

Центральная сущность анализа.

Содержит:

- `identity` — productKind, категория, названия, use cases, материалы;
- `sku` — summary, selected SKU, цвета, размеры, модели, риски SKU;
- `pricing` — отображение цены, выбранная цена, range, надёжность цены;
- `supplier` — тип поставщика, рейтинг, заказы;
- `procurement` — вопросы, проверки, риски, вывод;
- `cargo` — что запросить для доставки;
- `content` — SEO allowed/forbidden claims, идеи инфографики;
- `dataQuality` — недостающие поля, противоречия, confidence.

## Поддерживаемые productKind

Минимальный набор:

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

Для каждого productKind нужны свои вопросы, чек-листы, риски и SEO-ограничения.

## Примеры productKind-логики

### Обувь

Проверять:

- размерную сетку;
- длину стельки;
- вес пары;
- запах EVA/PU;
- качество литья/декора;
- упаковку.

### Зонт

Проверять:

- длину в сложенном виде;
- диаметр купола;
- количество спиц;
- механизм;
- чехол;
- UPF только как неподтверждённый claim.

### Маска для сна

Проверять:

- 3D-форму;
- затемнение;
- ремешок;
- запах;
- мягкость;
- комфорт 10–15 минут.

### Подогреватель блюд / электротовары

Проверять:

- напряжение;
- мощность;
- тип вилки;
- совместимость с РФ/ЕАЭС;
- температуру нагрева;
- сертификаты;
- видео работы;
- кабель и маркировку.

## Dangerous claims

Запрещено писать как факт без подтверждения:

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

## Callback policy

Все кнопки, связанные с конкретным анализом, должны содержать `analysisId`:

```text
supplier_questions:{analysisId}
procurement_package:{analysisId}
product_details:{analysisId}
download_zip:{analysisId}
new_product
```

Нельзя полагаться только на текущий session state. После успешного анализа кнопки должны открываться по сохранённому `analysisId`.

## Credits policy

Кредит списывается один раз — после успешной отправки результата.

Не списывать кредит при:

- открытии вопросов;
- открытии пакета;
- открытии данных товара;
- скачивании ZIP;
- возврате к отчёту.

В отчёте должна быть одна строка:

```text
📦 Осталось: {credits} анализов
```

## Валидаторы

Нужны валидаторы:

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

## Стек

- Node.js;
- TypeScript;
- Telegraf;
- Vercel serverless;
- Supabase PostgreSQL;
- Upstash Redis;
- OpenRouter;
- Fireworks fallback;
- Elim API.

## Env-переменные

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_TG_ID=

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

OPENROUTER_API_KEY=
CONTENT_MODEL=
FALLBACK_MODEL=
SECONDARY_FALLBACK_MODEL=
FIREWORKS_API_KEY=

ELIM_API_KEY=
```

Не хранить реальные секреты в README, CONTEXT или CLAUDE.md.

## Локальная разработка

```bash
npm install
cp .env.example .env
npm run dev
```

Проверка типов:

```bash
npx tsc --noEmit
```

Если есть тесты:

```bash
npm test
```

## Деплой

Проект деплоится на Vercel через GitHub.

Webhook Telegram:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<VERCEL_URL>/api/webhook&secret_token=<WEBHOOK_SECRET>"
```

## Тарифы MVP

Рекомендуемая стартовая сетка:

| Пакет | Цена |
|---|---:|
| 3 анализа | бесплатно |
| 10 анализов | 199 ₽ |
| 30 анализов | 499 ₽ |
| 100 анализов | 990 ₽ |

Telegram Stars можно использовать как альтернативный способ оплаты:

| Пакет | Stars |
|---|---:|
| 10 анализов | 150⭐ |
| 30 анализов | 300⭐ |
| 7 дней Pro | 500⭐ |

## Bulk — будущий режим

Bulk не является текущим ядром MVP.

Будущий сценарий:

```text
30 ссылок → bulk_summary.xlsx + общий ZIP с пакетами по товарам
```

Bulk нужно делать только после того, как одиночный закупочный пакет стабильно проходит валидаторы.

## Acceptance criteria

Версия считается готовой к платному тесту, если:

1. Кнопки `Вопросы`, `Пакет`, `Данные товара` работают по `analysisId`.
2. Главный отчёт не содержит противоречий selected SKU.
3. Нет `seller/factory/merchant` в пользовательском UI.
4. Вес без данных = `не указан`.
5. Нет двойного списания кредитов.
6. Вопросы поставщику не дублируются.
7. Китайский блок либо валидный, либо скрыт.
8. SEO не содержит dangerous claims.
9. ZIP содержит понятные файлы.
10. Один пакет можно отправить поставщику/байеру/карго без ручной чистки.
