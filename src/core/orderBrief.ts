import type { RawProduct1688, AiContentResult, EconomicsResult, RiskFlags, BudgetScenarios, PlatformConclusion } from '../types';
import { getCategoryChecklist } from './categoryChecklist';

const PLATFORM_STATUS: Record<string, string> = {
  '1688': 'закупочная гипотеза',
  taobao: 'розничная витрина / цена образца',
  tmall: 'брендовая розничная витрина',
};

export function formatOrderBrief(
  product: RawProduct1688,
  content: AiContentResult,
  economics: EconomicsResult,
  riskFlags: RiskFlags,
  sourceUrl: string,
  budgets?: BudgetScenarios | null,
  conclusion?: PlatformConclusion | null
): string {
  const L: string[] = [];

  L.push('# ТЗ для байера / карго');
  L.push('');
  L.push(`**Дата:** ${new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}`);
  L.push(`**Площадка:** ${(product.platform ?? '1688').toUpperCase()} · ${PLATFORM_STATUS[product.platform ?? '1688'] ?? product.platform ?? '1688'}`);
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
  } else {
    L.push('**Тип:** неизвестен');
  }
  if (product.supplierRating) L.push(`**Рейтинг:** ${product.supplierRating}/5`);
  if (product.sold) L.push(`**Заказов:** ${product.sold}+`);
  L.push('');

  // Закупка
  L.push('## 💰 Параметры закупки');
  L.push('');
  L.push(`**Цена:** ${product.priceYuan} ¥ (~${economics.breakdown.purchaseRub} ₽)`);
  L.push(`**Статус цены:** ${PLATFORM_STATUS[product.platform]}`);
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
    const validTiers = product.priceRange.filter((r) =>
      Number.isFinite(r.minQty) && r.minQty > 0 && Number.isFinite(r.price) && r.price > 0
    );
    if (validTiers.length) {
      L.push('### Оптовые цены');
      L.push('');
      L.push('| От (шт.) | Цена (¥) |');
      L.push('|----------|----------|');
      validTiers.slice(0, 5).forEach((r) => {
        L.push(`| ${r.minQty} | ${r.price} ¥ |`);
      });
      L.push('');
    } else {
      const prices = product.priceRange.map((r) => r.price).filter(Boolean);
      if (prices.length) {
        L.push(`Оптовая цена: от ${Math.min(...prices)} ¥`);
        L.push('Пороги количества не распознаны. Уточните цену на 20, 50 и 100 шт.');
        L.push('');
      }
    }
  }

  // SKU
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

  // Характеристики с маркерами достоверности
  if (product.attributes?.length) {
    L.push('## 📋 Характеристики (оригинал поставщика)');
    L.push('');
    L.push('| Параметр | Значение | Статус |');
    L.push('|----------|----------|--------|');
    product.attributes.slice(0, 15).forEach((a) => {
      L.push(`| ${a.name} | ${a.value} | ✓ от поставщика |`);
    });
    L.push('');
  }

  if (Object.keys(content.characteristics).length) {
    L.push('## 📋 Характеристики (перевод)');
    L.push('');
    L.push('| Параметр | Значение | Статус |');
    L.push('|----------|----------|--------|');
    Object.entries(content.characteristics).forEach(([k, v]) => {
      L.push(`| ${k} | ${v} | ~ перевод |`);
    });
    L.push('');
  }

  // Бюджеты
  if (budgets && economics.platformMode === 'full') {
    const wmLabel = budgets.weightMissing ? ' — без карго' : '';
    L.push(`## 🧪 Бюджет закупки${wmLabel}`);
    L.push('');
    const itogo = budgets.weightMissing ? 'Итого без карго' : 'Итого';
    L.push(`| Сценарий | Кол-во | Товар+банк | Резерв 15% | ${itogo} |`);
    L.push('|----------|--------|------------|------------|--------|');
    [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
      L.push(`| ${s.label} | ${s.quantity} шт | ${s.goodsCostRub} ₽ | ${s.reserveRub} ₽ | **${s.totalRub} ₽** |`);
    });
    if (budgets.weightMissing) {
      L.push('');
      L.push('> Карго не включено: поставщик не указал вес единицы с упаковкой.');
    }
    L.push('');
  } else if (economics.platformMode === 'sample_only') {
    L.push('## 🧪 Стоимость образца');
    L.push('');
    L.push(`1 шт. по цене витрины: ~${economics.costRub} ₽`);
    L.push('');
    L.push('> Для партий 20/50/100 шт. запросите цену у продавца.');
    L.push('');
  }

  // Алерты
  L.push('## ⚠️ Что проверить перед заказом');
  L.push('');
  const checks: string[] = [];
  checks.push('Запросить реальные фото товара на складе');
  if (product.weightKg <= 0) checks.push('Уточнить точный вес единицы с упаковкой');
  if (riskFlags.isElectrical) checks.push('Проверить напряжение (220V), тип вилки, наличие аккумулятора');
  if (riskFlags.sizeGridRelevant) checks.push('Запросить размерную таблицу в сантиметрах');
  if (riskFlags.hasBrand) checks.push(`Уточнить возможность поставки без логотипа "${riskFlags.brand ?? ''}"`);
  if (product.platform !== '1688') checks.push('Запросить оптовую цену на 20/50/100 шт.');
  if (product.platform === 'tmall') checks.push('Проверить права на бренд и товарный знак');
  checks.push('Согласовать упаковку (нейтральная, без иероглифов)');
  checks.push('Проверить качество на образце перед партией');

  const aiWarnings = content.warnings ?? [];
  const categoryChecks = getCategoryChecklist(riskFlags, product.categoryName);
  [...aiWarnings, ...checks].forEach((c) => L.push(`- ${c}`));

  if (categoryChecks.length) {
    L.push('');
    L.push('### Категорийный чек-лист');
    L.push('');
    categoryChecks.forEach((c) => L.push(`- [ ] ${c}`));
  }
  L.push('');

  // Вопросы поставщику (китайский)
  if (content.supplierQuestions?.cn?.length) {
    L.push('## 📩 Сообщение поставщику (中文)');
    L.push('');
    L.push('```');
    content.supplierQuestions.cn.forEach((q) => L.push(q));
    L.push('```');
    L.push('');
  }

  // Экономика
  L.push('## 📊 Расчёт (справочно)');
  L.push('');
  if (economics.weightMissing) {
    L.push('**Статус экономики: НЕПОЛНАЯ**');
    L.push('**Причина:** отсутствует вес товара с упаковкой.');
    L.push('');
    L.push(`- Себестоимость без карго: ~${economics.costRub} ₽`);
    L.push(`- Курс: 1 ¥ = ${economics.yuanToRub.toFixed(2)} ₽`);
  } else {
    L.push(`- Себестоимость: ~${economics.costRub} ₽`);
    L.push(`- Курс: 1 ¥ = ${economics.yuanToRub.toFixed(2)} ₽`);
    if (economics.platformMode === 'full' && !economics.isSyntheticPrice) {
      L.push(`- Цена продажи (медиана WB): ${economics.avgSaleRub} ₽`);
      L.push(`- Ориентировочная прибыль: ${economics.grossProfitRub} ₽`);
      L.push(`- ROI: ${economics.roiPercent}%`);
    }
  }
  L.push('');

  // Допущения
  L.push('### Допущения расчёта');
  L.push('');
  L.push(`- Банковская комиссия: ${economics.breakdown.bankMarkupRub > 0 ? '3%' : 'не учтена'}`);
  L.push(`- Карго: ${economics.weightMissing ? 'не учтено (нет веса)' : economics.breakdown.cargoRub + ' ₽'}`);
  L.push(`- Фулфилмент: ${economics.breakdown.internalLogisticsRub} ₽`);
  L.push(`- Комиссия WB: 20%`);
  L.push(`- ДРР: ${economics.breakdown.drrPercent}%`);
  L.push(`- Налог: 7%`);
  L.push(`- ${economics.isCustomTariffs ? 'Тарифы пользователя' : 'Тарифы по умолчанию'}`);
  L.push('');

  // Вывод
  if (conclusion) {
    L.push(`## ${conclusion.icon} Вывод`);
    L.push('');
    L.push(conclusion.headline);
    conclusion.disclaimers.forEach((d) => L.push(`> ⚠️ ${d}`));
    L.push('');
  }

  L.push('---');
  L.push(`*Сгенерировано: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}*`);
  L.push('*CardZip | @cardzip_bot*');

  return L.join('\n');
}
