import type { RawProduct1688, AiContentResult, EconomicsResult, RiskFlags } from '../types';

export function formatOrderBrief(
  product: RawProduct1688,
  content: AiContentResult,
  economics: EconomicsResult,
  riskFlags: RiskFlags,
  sourceUrl: string
): string {
  const L: string[] = [];

  L.push('# ТЗ для байера / карго');
  L.push('');
  L.push(`**Дата:** ${new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}`);
  L.push(`**Бот:** @cardzip_bot`);
  L.push('');

  // Ссылка
  L.push('## 🔗 Ссылка на товар');
  L.push('');
  L.push(sourceUrl);
  L.push('');

  // Товар
  L.push('## 📦 Товар');
  L.push('');
  L.push(`**Название (RU):** ${content.titleRu}`);
  L.push(`**Название (CN):** ${product.titleCn}`);
  if (product.titleEn) L.push(`**Название (EN):** ${product.titleEn}`);
  L.push('');

  // Поставщик
  L.push('## 🏭 Поставщик');
  L.push('');
  L.push(`**Магазин:** ${product.supplierName}`);
  if (product.supplierType) {
    const types = { factory: 'Фабрика', merchant: 'Торговая компания', seller: 'Продавец' };
    L.push(`**Тип:** ${types[product.supplierType]}`);
  }
  if (product.supplierRating) L.push(`**Рейтинг:** ${product.supplierRating}/5`);
  if (product.sold) L.push(`**Заказов:** ${product.sold}+`);
  L.push('');

  // Закупка
  L.push('## 💰 Параметры закупки');
  L.push('');
  L.push(`**Цена:** ${product.priceYuan} ¥ (~${economics.breakdown.purchaseRub} ₽)`);
  L.push(`**MOQ:** ${product.moq} шт.`);
  if (product.weightKg > 0) {
    L.push(`**Вес единицы:** ${product.weightKg} кг`);
  } else {
    L.push('**Вес:** ⚠️ Не указан — уточнить у поставщика!');
  }
  if (product.stock) L.push(`**Остаток:** ${product.stock} шт.`);
  L.push('');

  // Оптовые цены
  if (product.priceRange?.length) {
    L.push('### Оптовые цены');
    L.push('');
    L.push('| От (шт.) | Цена (¥) |');
    L.push('|----------|----------|');
    product.priceRange.slice(0, 5).forEach((r) => {
      L.push(`| ${r.minQty} | ${r.price} ¥ |`);
    });
    L.push('');
  }

  // SKU / Варианты
  if (product.skus?.length) {
    L.push('## 🎨 Варианты (SKU)');
    L.push('');
    L.push('| Вариант | Цена | Остаток |');
    L.push('|---------|------|---------|');
    product.skus.slice(0, 10).forEach((sku) => {
      L.push(`| ${sku.name} | ${sku.price ? sku.price + ' ¥' : '—'} | ${sku.stock ?? '—'} |`);
    });
    L.push('');
  }

  // Характеристики с оригиналом
  if (product.attributes?.length) {
    L.push('## 📋 Характеристики (оригинал)');
    L.push('');
    L.push('| Параметр | Значение |');
    L.push('|----------|----------|');
    product.attributes.slice(0, 15).forEach((a) => {
      L.push(`| ${a.name} | ${a.value} |`);
    });
    L.push('');
  }

  // Переведённые характеристики
  if (Object.keys(content.characteristics).length) {
    L.push('## 📋 Характеристики (перевод)');
    L.push('');
    L.push('| Параметр | Значение |');
    L.push('|----------|----------|');
    Object.entries(content.characteristics).forEach(([k, v]) => {
      L.push(`| ${k} | ${v} |`);
    });
    L.push('');
  }

  // Алерты для байера
  L.push('## ⚠️ Что проверить перед заказом');
  L.push('');
  const checks: string[] = [];
  checks.push('Запросить реальные фото товара на складе в Гуанчжоу');
  if (product.weightKg <= 0) checks.push('Уточнить точный вес единицы с упаковкой');
  if (riskFlags.isElectrical) checks.push('Проверить напряжение (220V), тип вилки, наличие аккумулятора');
  if (riskFlags.sizeGridRelevant) checks.push('Запросить размерную таблицу в сантиметрах');
  if (riskFlags.hasBrand) checks.push(`Уточнить возможность поставки без логотипа "${riskFlags.brand ?? ''}"`);
  checks.push('Проверить качество швов / сборки на образце');
  checks.push('Согласовать упаковку (нейтральная, без иероглифов)');

  const warnings = content.warnings ?? [];
  [...warnings, ...checks].forEach((c) => L.push(`- ${c}`));
  L.push('');

  // Экономика
  L.push('## 📊 Расчёт (справочно)');
  L.push('');
  L.push(`- Себестоимость в РФ: ~${economics.costRub} ₽`);
  L.push(`- Курс: 1 ¥ = ${economics.yuanToRub.toFixed(2)} ₽`);
  if (!economics.isSyntheticPrice) {
    L.push(`- Медианная цена WB: ${economics.avgSaleRub} ₽`);
  }
  L.push(`- ROI: ${economics.roiPercent}%`);
  L.push('');

  L.push('---');
  L.push('*Сгенерировано CardZip | @cardzip_bot*');

  return L.join('\n');
}
