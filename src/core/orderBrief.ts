import type { RawProduct1688, AiContentResult, EconomicsResult, RiskFlags, BudgetScenarios, PlatformConclusion, ProductIntelligence } from '../types';
import { getCategoryChecklist } from './categoryChecklist';
import { getCategoryRules, detectCategoryFromAttributes, type ProductCategoryType } from './categoryRules';

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
  const normalized = product.normalized1688;
  const pricing = normalized?.pricing;
  const catType: ProductCategoryType = ((product as any).categoryType as ProductCategoryType) ??
    detectCategoryFromAttributes(product.categoryName, product.attributes ?? [], product.titleCn);
  const catRules = getCategoryRules(catType);
  const catForbidden = catRules.forbiddenFields;

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
  if (normalized?.supplierType ?? product.supplierType) {
    const types = { factory: 'Фабрика', merchant: 'Торговая компания', seller: 'Продавец' };
    L.push(`**Тип:** ${types[(normalized?.supplierType ?? product.supplierType)!]}`);
  } else {
    L.push('**Тип:** неизвестен');
  }
  if (product.supplierRating) L.push(`**Рейтинг:** ${product.supplierRating}/5`);
  if (normalized?.salesCount ?? product.sold) L.push(`**Заказов:** ${normalized?.salesCount ?? product.sold}+`);
  if (normalized?.repurchaseRate) L.push(`**Повторные покупки:** ${normalized.repurchaseRate}`);
  L.push('');

  // Закупка
  L.push('## 💰 Параметры закупки');
  L.push('');
  L.push(`**Цена:** ${pricing?.displayPriceYuan ?? product.priceYuan} ¥ (~${economics.breakdown.purchaseRub} ₽)`);
  if (pricing?.quoteType) L.push(`**Тип котировки:** ${pricing.quoteType}`);
  L.push(`**Статус цены:** ${PLATFORM_STATUS[product.platform]}`);
  L.push(`**MOQ:** ${normalized?.moq ?? product.moq} шт.`);
  if ((normalized?.weightKg ?? product.weightKg) > 0) {
    L.push(`**Вес единицы:** ${normalized?.weightKg ?? product.weightKg} кг`);
  } else {
    L.push('**Вес:** ⚠️ Не указан — уточнить у поставщика!');
  }
  if (product.stock) L.push(`**Остаток:** ${product.stock} шт.`);
  L.push('');

  // Оптовые цены
  if ((pricing?.priceRanges ?? product.priceRange)?.length) {
    const validTiers = (pricing?.priceRanges ?? product.priceRange ?? []).filter((r) =>
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
      const prices = (pricing?.priceRanges ?? product.priceRange ?? []).map((r) => r.price).filter(Boolean);
      if (prices.length) {
        L.push(`Оптовая цена: от ${Math.min(...prices)} ¥`);
        L.push('Пороги количества не распознаны. Уточните цену на 20, 50 и 100 шт.');
        L.push('');
      }
    }
  }

  // SKU
  if ((normalized?.skuVariants ?? product.skus)?.length) {
    L.push('## 🎨 Варианты (SKU)');
    L.push('');
    L.push('| Вариант | Цена | Остаток |');
    L.push('|---------|------|---------|');
    (normalized?.skuVariants ?? product.skus ?? []).slice(0, 10).forEach((sku) => {
      L.push(`| ${sku.name} | ${sku.price ? sku.price + ' ¥' : '—'} | ${sku.stock ?? '—'} |`);
    });
    L.push('');
  }

  // Характеристики с маркерами достоверности
  if ((normalized?.attributes ?? product.attributes)?.length) {
    L.push('## 📋 Характеристики (оригинал поставщика)');
    L.push('');
    L.push('| Параметр | Значение | Статус |');
    L.push('|----------|----------|--------|');
    (normalized?.attributes ?? product.attributes ?? []).slice(0, 15).forEach((a) => {
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

  const intel: ProductIntelligence | undefined = (product as any).intelligence;
  const buyerMustNotAsk = new Set(
    (intel?.reportRules?.buyerMustNotAsk ?? []).map((s: string) => s.toLowerCase())
  );

  if (intel?.reportRules?.buyerMustCheck?.length) {
    // Intelligence-driven checklist (primary)
    const intelChecks = intel.reportRules.buyerMustCheck.filter(
      (c) => !buyerMustNotAsk.has(c.toLowerCase())
    );
    intelChecks.forEach((c) => L.push(`- ${c}`));

    // Add missing critical fields as "уточнить" items
    if (intel.dataQuality?.missingCriticalFields?.length) {
      L.push('');
      L.push('### Требуется уточнить');
      L.push('');
      intel.dataQuality.missingCriticalFields.forEach((f) => L.push(`- [ ] ${f}`));
    }
  } else {
    // Fallback to generic checks
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

    // Filter checks by category forbidden fields
    const filteredChecks = checks.filter((c) => {
      const cl = c.toLowerCase();
      return !catForbidden.some((f) => cl.includes(f.toLowerCase()));
    });

    const aiWarnings = content.warnings ?? [];
    const categoryChecks = getCategoryChecklist(riskFlags, product.categoryName);
    [...aiWarnings, ...filteredChecks].forEach((c) => L.push(`- ${c}`));

    // Category-specific checklist from categoryRules
    const catSpecificChecks = catRules.supplierQuestions.ru
      .filter((q) => !catForbidden.some((f) => q.toLowerCase().includes(f.toLowerCase())));
    const allCategoryChecks = [...categoryChecks, ...catSpecificChecks.slice(0, 5)];
    // Deduplicate
    const seenChecks = new Set<string>();
    const uniqueCategoryChecks = allCategoryChecks.filter((c) => {
      const key = c.toLowerCase().trim();
      if (seenChecks.has(key)) return false;
      seenChecks.add(key);
      return true;
    });

    if (uniqueCategoryChecks.length) {
      L.push('');
      L.push('### Категорийный чек-лист');
      L.push('');
      uniqueCategoryChecks.forEach((c) => L.push(`- [ ] ${c}`));
    }
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
