import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus, ProductAttribute, PriceRange } from '../types';

function esc(s: unknown): string {
  const str = String(s ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitize(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s]+/gi, '')
    .replace(/\/(?:tmp|var|home|Users)\/[^\s]+/g, '')
    .trim();
}

function fP(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function fN(n: number): string {
  return n.toLocaleString('ru-RU');
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function formatCreditsLine(status: SubscriptionStatus): string {
  if (status.plan === 'week') {
    const word = pluralize(status.creditsRemaining, 'анализ', 'анализа', 'анализов');
    let line = `⚡ Pro-неделя`;
    if (status.activeUntil) line += ` до ${status.activeUntil.toLocaleDateString('ru-RU')}`;
    return line + ` · осталось ${status.creditsRemaining} ${word}`;
  }
  if (status.creditsRemaining <= 0) return '📦 Анализы использованы.';
  const word = pluralize(status.creditsRemaining, 'анализ', 'анализа', 'анализов');
  return `📦 Осталось: ${status.creditsRemaining} ${word}`;
}

function extractAttr(attrs: ProductAttribute[] | undefined, keys: string[]): string {
  if (!attrs?.length) return '';
  for (const a of attrs) {
    if (keys.some((k) => a.name.toLowerCase().includes(k.toLowerCase()))) return a.value;
  }
  return '';
}

function formatTiersShort(pr: PriceRange[]): string {
  const valid = pr.filter((r) => r.minQty > 0);
  if (!valid.length) return 'не распознаны';
  return valid.map((r) => `${r.minQty}+ → ${r.price}¥`).join(', ');
}

function formatSupplierType(value: string | undefined): string {
  const map: Record<string, string> = {
    factory: 'Фабрика',
    merchant: 'Торговая компания',
    seller: 'Продавец',
  };
  return map[value ?? ''] ?? 'не указано';
}

function format1688Price(product: ProductWithContent): string {
  const pricing = product.normalized1688?.pricing;
  if (!pricing) return `${product.priceYuan} ¥`;

  if (pricing.quoteType === 'by_sku') {
    if (pricing.skuMinPriceYuan && pricing.skuMaxPriceYuan && pricing.skuMinPriceYuan !== pricing.skuMaxPriceYuan) {
      return `${pricing.skuMinPriceYuan}–${pricing.skuMaxPriceYuan} ¥`;
    }
    return `${pricing.displayPriceYuan} ¥`;
  }

  if (pricing.quoteType === 'by_volume') {
    if (pricing.volumeMinPriceYuan && pricing.volumeMaxPriceYuan && pricing.volumeMinPriceYuan !== pricing.volumeMaxPriceYuan) {
      return `${pricing.volumeMinPriceYuan}–${pricing.volumeMaxPriceYuan} ¥`;
    }
    return `${pricing.displayPriceYuan} ¥`;
  }

  return `${pricing.displayPriceYuan} ¥`;
}

const PLATFORM_LABELS: Record<string, string> = {
  '1688': '1688',
  taobao: 'Taobao',
  tmall: 'Tmall',
};

// ─── Главное сообщение (единственное после анализа) ─────────────────────────

export function buildMainMessage(
  product: ProductWithContent,
  jobId: string,
  status?: SubscriptionStatus,
): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { wbFiltered, economics, conclusion, similarityData: sim } = product;
  if (!economics) {
    return { text: '❌ Данные анализа неполные.', keyboard: Markup.inlineKeyboard([[Markup.button.callback('🔄 Новый товар', 'new_search')]]) };
  }
  const safeConclusion = conclusion ?? { platform: product.platform, icon: '🟡', headline: 'Нужны данные для оценки', disclaimers: [] };
  const wm = economics.weightMissing;
  const hasConfirmedAnalogs = !!(sim && (sim.directCount ?? sim.highCount ?? 0) > 0);
  const hasMarket = !!(wbFiltered && wbFiltered.relevantCount > 0 && wbFiltered.medianPrice > 0);
  const L: string[] = [];

  // ─── Товар ──────────────────────────────────────────────────────────────────
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');
  L.push(`Источник: ${PLATFORM_LABELS[product.platform] ?? product.platform}`);

  L.push(`Цена: ${format1688Price(product)}`);
  if (product.supplierName) L.push(`Поставщик: ${esc(product.supplierName)}`);

  // ─── Данные 1688 (выжимка) ─────────────────────────────────────────────────
  L.push('');
  L.push('📌 <b>Данные 1688</b>');
  const normalized = product.normalized1688;
  L.push(`• Цена: ${format1688Price(product)}`);
  L.push(`• MOQ: ${normalized?.moq ? `${normalized.moq} шт` : 'не указано'}`);
  L.push(`• SKU: ${normalized?.skuCount ? `${normalized.skuCount} вариантов` : 'не указано'}`);
  L.push(`• Supplier type: ${formatSupplierType(normalized?.supplierType ?? product.supplierType)}`);
  if (normalized?.salesCount != null || normalized?.repurchaseRate) {
    L.push(`• Продажи / повторные: ${normalized?.salesCount != null ? fN(normalized.salesCount) : 'не указано'} / ${normalized?.repurchaseRate ?? 'не указано'}`);
  }
  L.push(`• Фото: ${normalized?.imageCount ?? product.images?.length ?? 0} шт`);
  L.push(`• Вес: ${product.weightKg > 0 ? `${product.weightKg} кг` : 'не указано'}`);
  (normalized?.keyAttributes ?? []).slice(0, 5).forEach((attr) => {
    L.push(`• ${esc(attr.label)}: ${esc(attr.value)}`);
  });
  const hasTiers = product.priceRange?.some((r) => r.minQty > 0);
  if (hasTiers) L.push(`• Скидки: ${formatTiersShort(product.priceRange!)}`);

  // ─── Статус ─────────────────────────────────────────────────────────────────
  L.push('');
  if (wm || !hasConfirmedAnalogs) {
    L.push('🟡 <b>Статус: нужны данные</b>');
  } else if (economics.grossProfitRub > 0) {
    L.push('🟢 <b>Статус: можно тестировать</b>');
  } else {
    L.push('🔴 <b>Статус: экономика слабая</b>');
  }

  // ─── Рынок WB ──────────────────────────────────────────────────────────────
  L.push('');
  L.push('🔎 <b>Рынок WB</b>');
  if (hasConfirmedAnalogs) {
    L.push(`Прямые аналоги найдены: ${sim!.directCount ?? sim!.highCount ?? 0}`);
    if (hasMarket) L.push(`Медиана цены: ${fP(wbFiltered!.medianPrice)}`);
  } else if (sim?.categoryCount && sim.categoryCount > 0) {
    L.push('Прямые аналоги пока не подтверждены.');
    L.push('Категория на WB найдена.');
  } else {
    L.push('Прямые аналоги на WB пока не найдены.');
  }

  // ─── Экономика ──────────────────────────────────────────────────────────────
  L.push('');
  L.push('💰 <b>Экономика</b>');
  if (economics.platformMode === 'full') {
    if (wm) {
      L.push('Расчёт предварительный.');
      L.push(`Себестоимость без карго: ${fP(economics.costRub)}`);
      L.push('Вес не указан — карго, маржа и ROI не рассчитаны.');
    } else if (!hasConfirmedAnalogs || economics.isSyntheticPrice) {
      L.push('Расчёт предварительный.');
      L.push(`Себестоимость: ${fP(economics.costRub)}`);
      L.push('Рынок не подтверждён — ROI не рассчитан.');
    } else {
      L.push(`Себестоимость: ${fP(economics.costRub)}`);
      if (wbFiltered) {
        const b = economics.breakdown;
        const profitMed = wbFiltered.medianPrice - economics.costRub
          - Math.round(wbFiltered.medianPrice * 0.20) - 100
          - Math.round(wbFiltered.medianPrice * b.drrPercent / 100)
          - Math.round(wbFiltered.medianPrice * 0.07);
        const sign = profitMed >= 0 ? '+' : '';
        L.push(`Прибыль (медиана): ${sign}${fP(profitMed)}`);
        if (economics.roiPercent) L.push(`ROI: ${economics.roiPercent}%`);
      }
    }
  } else if (economics.platformMode === 'sample_only') {
    L.push(`Образец: ~${fP(economics.costRub)}`);
    L.push('Это розничная цена, не цена партии.');
  } else {
    L.push(`Витрина: ${economics.breakdown.purchaseYuan} ¥`);
    L.push('Брендовый референс — найдите OEM на 1688.');
  }

  // ─── Что уточнить ───────────────────────────────────────────────────────────
  const clarify: string[] = [];
  if (wm) clarify.push('вес с упаковкой');
  if (wm) clarify.push('размеры упаковки');
  if (product.priceIsRange) clarify.push('цену выбранного SKU');
  clarify.push('MOQ / минимальную партию');
  if (product.riskFlags?.sizeGridRelevant) clarify.push('размерную сетку');

  if (clarify.length) {
    L.push('');
    L.push('📌 <b>Что уточнить у поставщика</b>');
    clarify.forEach((c) => L.push(`• ${c}`));
  }

  // ─── Вердикт ────────────────────────────────────────────────────────────────
  L.push('');
  L.push('🎯 <b>Вердикт</b>');
  L.push(esc(safeConclusion.headline));
  L.push(buildVerdictAdvice(wm, hasConfirmedAnalogs, economics.grossProfitRub, economics.platformMode));

  // ─── Остаток анализов ───────────────────────────────────────────────────────
  if (status) {
    L.push('');
    L.push(formatCreditsLine(status));
  }

  // ─── Кнопки ─────────────────────────────────────────────────────────────────
  const buttons: any[][] = [
    [
      Markup.button.callback('📦 Данные 1688', `product_detail_${jobId}`),
      Markup.button.callback('🔎 WB-рынок', `wb_detail_${jobId}`),
    ],
    [
      Markup.button.callback('💰 Экономика', `econ_detail_${jobId}`),
      Markup.button.callback('💬 Поставщику', 'supplier_questions'),
    ],
    [
      Markup.button.callback('📎 Файлы', `materials_${jobId}`),
      Markup.button.callback('🔄 Новый товар', 'new_search'),
    ],
  ];

  if (status && status.creditsRemaining <= 1) {
    buttons.push([
      Markup.button.callback('💳 Купить анализы', 'buy_analyses'),
    ]);
  }

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

function buildVerdictAdvice(wm: boolean, hasAnalogs: boolean, profit: number, mode: string): string {
  if (mode === 'reference_only') return 'Этот товар — брендовый референс. Найдите OEM-аналог на 1688.';
  if (mode === 'sample_only') return 'Закажите образец и запросите оптовую цену для расчёта партии.';
  if (wm && !hasAnalogs) return 'Сначала уточните данные у поставщика и повторите расчёт.';
  if (wm) return 'Уточните вес и размеры у поставщика — после этого бот рассчитает полную экономику.';
  if (!hasAnalogs) return 'Проверьте рынок WB вручную или попробуйте другой товар.';
  if (profit > 0) return 'Экономика положительная. Можно заказывать тестовую партию.';
  return 'Экономика слабая. Попробуйте договориться о лучшей цене или выбрать другой товар.';
}

// ─── Экономика (по кнопке) ──────────────────────────────────────────────────

export function buildEconomicsDetail(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { economics, wbFiltered, maxPurchasePrice, budgets } = product;
  if (!economics) return { text: '💰 Данные экономики недоступны.', keyboard: Markup.inlineKeyboard([]) };
  const b = economics.breakdown;
  const wm = economics.weightMissing;
  const hasConfirmedAnalogs = !!(product.similarityData && (product.similarityData.directCount ?? product.similarityData.highCount ?? 0) > 0);
  const L: string[] = [];

  L.push('💰 <b>Экономика</b>');
  L.push('');

  if (economics.platformMode === 'full') {
    if (wm) {
      L.push('Расчёт предварительный: нет веса товара.');
      L.push('');
    }

    // Объясняем разницу цен, если priceRange
    if (product.priceRange?.length) {
      const valid = product.priceRange.filter((r) => r.minQty > 0);
      if (valid.length) {
        const minPrice = valid[valid.length - 1].price;
        if (minPrice !== b.purchaseYuan) {
          L.push(`Цена товара: от ${minPrice} ¥`);
          L.push(`Расчётный SKU: ${b.purchaseYuan} ¥ ≈ ${fP(b.purchaseRub)}`);
        } else {
          L.push(`Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
        }
      } else {
        L.push(`Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
      }
    } else {
      L.push(`Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
    }

    L.push(`Банк / обмен: +${fP(b.bankMarkupRub)}`);
    if (!wm) {
      L.push(`Карго (${product.weightKg} кг): +${fP(b.cargoRub)}`);
    }
    L.push(`Фулфилмент: +${fP(b.internalLogisticsRub)}`);
    L.push('');
    L.push(`<b>Себестоимость${wm ? ' без карго' : ''}: ${fP(economics.costRub)}</b>`);

    // Что не рассчитано
    if (wm || !hasConfirmedAnalogs || economics.isSyntheticPrice) {
      const missing: string[] = [];
      if (wm) missing.push('карго — нет веса');
      if (!hasConfirmedAnalogs || economics.isSyntheticPrice) missing.push('маржа — нет подтверждённой цены WB');
      if (wm || !hasConfirmedAnalogs) missing.push('ROI — нет ' + [wm ? 'веса' : '', !hasConfirmedAnalogs ? 'рынка WB' : ''].filter(Boolean).join(' и '));

      L.push('');
      L.push('<b>Не рассчитано:</b>');
      missing.forEach((m) => L.push(`• ${m}`));
    }

    // Полные сценарии
    if (!wm && !economics.isSyntheticPrice && hasConfirmedAnalogs && wbFiltered) {
      const calcProfit = (salePrice: number) => {
        const comm = Math.round(salePrice * 0.20);
        const drr = Math.round(salePrice * b.drrPercent / 100);
        const tax = Math.round(salePrice * 0.07);
        return salePrice - economics.costRub - comm - 100 - drr - tax;
      };
      const fSign = (n: number) => (n >= 0 ? '+' : '') + fP(n);

      L.push('');
      L.push('<b>Прибыль по сценариям:</b>');
      L.push(`Консервативный (P25: ${fP(wbFiltered.p25Price)}): ${fSign(calcProfit(wbFiltered.p25Price))}`);
      L.push(`Базовый (медиана: ${fP(wbFiltered.medianPrice)}): <b>${fSign(calcProfit(wbFiltered.medianPrice))}</b>`);
      L.push(`Оптимистичный (P75: ${fP(wbFiltered.p75Price)}): ${fSign(calcProfit(wbFiltered.p75Price))}`);
      L.push(`<i>Комиссия 20%, ДРР ${b.drrPercent}%, налог 7%, логистика WB 100₽</i>`);
    }

    if (maxPurchasePrice && !wm && !economics.isSyntheticPrice && hasConfirmedAnalogs) {
      L.push('');
      L.push('<b>Целевая закупочная цена</b>');
      if (maxPurchasePrice.maxYuan > 0) {
        L.push(`Макс. цена (маржа ${maxPurchasePrice.targetMarginPercent}%): <b>${maxPurchasePrice.maxYuan.toFixed(1)} ¥</b>`);
        L.push(`Текущая: ${maxPurchasePrice.currentYuan} ¥`);
        L.push(maxPurchasePrice.allowed ? '✅ Текущая цена проходит' : `❌ Нужна цена ниже ${maxPurchasePrice.maxYuan.toFixed(0)} ¥`);
      } else {
        L.push(`❌ Целевая маржа ${maxPurchasePrice.targetMarginPercent}% недостижима.`);
      }
    }

    if (budgets) {
      L.push('');
      if (wm) {
        L.push('<b>Бюджет (без карго):</b>');
        [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
          L.push(`${s.label}, ${s.quantity} шт: ~${fP(s.goodsCostRub)}`);
        });
        L.push('<i>Карго не включено — нет веса.</i>');
      } else {
        L.push('<b>Бюджет закупки:</b>');
        [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
          L.push(`${s.label} — ${s.quantity} шт: ~<b>${fP(s.totalRub)}</b>`);
        });
      }
    }
  } else if (economics.platformMode === 'sample_only') {
    L.push(`Цена витрины: ${b.purchaseYuan} ¥ · розничная`);
    L.push(`Стоимость образца: ~${fP(economics.costRub)}`);
    L.push('<i>Запросите цену на 20/50/100 шт. для расчёта партии.</i>');
  } else {
    L.push(`Цена витрины: ${b.purchaseYuan} ¥ (~${fP(b.purchaseRub)})`);
    L.push('<i>Брендовый референс. Найдите OEM-аналог на 1688.</i>');
  }

  if (wm || !hasConfirmedAnalogs) {
    L.push('');
    L.push('📌 Для полного расчёта нужен вес с упаковкой.');
  }

  const buttons = [
    [Markup.button.callback('📥 Внести ответ поставщика', 'supplier_confirm')],
    [Markup.button.callback('⚙️ Изменить параметры', 'edit_params')],
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
  ];

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── WB-рынок (по кнопке) ──────────────────────────────────────────────────

export function buildWbDetail(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { wbFiltered, similarityData: sim } = product;
  const L: string[] = [];

  L.push('🔎 <b>WB-рынок</b>');
  L.push('');

  if (sim && sim.totalAnalyzed > 0) {
    const confMap: Record<string, [string, string]> = {
      high: ['🟢', 'Высокая'], medium: ['🟡', 'Средняя'], low: ['🟠', 'Низкая'],
      crossborder_only: ['🟤', 'Только cross-border'],
      category_only: ['🔵', 'Только категория'], no_market: ['🔴', 'Не подтверждён'],
    };
    const [confIcon, confLabel] = confMap[sim.confidence ?? ''] ?? ['🔴', 'Не подтверждён'];
    L.push(`${confIcon} Уверенность: <b>${confLabel}</b>`);
    L.push(`Прямые аналоги: ${sim.directCount ?? sim.highCount ?? 0}`);
    L.push(`Похожие: ${sim.similarCount ?? sim.mediumCount ?? 0}`);
    if (sim.crossBorderCount) L.push(`Cross-border: ${sim.crossBorderCount}`);
    if (sim.categoryCount) L.push(`Категория: ${sim.categoryCount}`);
  }

  if (wbFiltered && wbFiltered.relevantCount > 0 && wbFiltered.medianPrice > 0) {
    L.push('');
    L.push('<b>Цены аналогов:</b>');
    L.push(`P25: ${fP(wbFiltered.p25Price)} | Медиана: <b>${fP(wbFiltered.medianPrice)}</b> | P75: ${fP(wbFiltered.p75Price)}`);

    if (wbFiltered.topExamples.length) {
      L.push('');
      L.push('🎯 <b>Ближайшие товары:</b>');
      wbFiltered.topExamples.slice(0, 5).forEach((ex, i) => {
        const t = ex.title.length > 35 ? ex.title.slice(0, 32) + '...' : ex.title;
        L.push(`${i + 1}. <a href="${ex.url}">${fP(ex.price)}</a> ⭐${ex.rating} 💬${fN(ex.feedbacks)} — ${esc(t)}`);
      });
    }

    const leaders = sim?.leaders;
    if (leaders?.length) {
      const top = leaders.filter((l: any) => l.feedbacks > 50).slice(0, 3);
      if (top.length) {
        L.push('');
        L.push('🏆 <b>Лидеры рынка:</b>');
        top.forEach((ex: any, i: number) => {
          const t = (ex.title ?? '').length > 35 ? ex.title.slice(0, 32) + '...' : ex.title ?? '';
          L.push(`${i + 1}. <a href="${ex.url}">${fP(ex.price)}</a> ⭐${ex.rating} 💬${fN(ex.feedbacks)} — ${esc(t)}`);
        });
      }
    }

    L.push('');
    const demandIcon = wbFiltered.totalFeedbacks > 1000 ? '🟢' : wbFiltered.totalFeedbacks > 100 ? '🟡' : '🔴';
    const compIcon = wbFiltered.relevantCount > 50 ? '🔴' : wbFiltered.relevantCount > 20 ? '🟡' : '🟢';
    L.push(`Спрос: ${demandIcon} ${wbFiltered.totalFeedbacks > 1000 ? 'Есть' : wbFiltered.totalFeedbacks > 100 ? 'Средний' : 'Слабый'}`);
    L.push(`Конкуренция: ${compIcon} ${wbFiltered.relevantCount > 50 ? 'Высокая' : wbFiltered.relevantCount > 20 ? 'Средняя' : 'Низкая'}`);
  } else {
    L.push('Прямые аналоги пока не подтверждены.');
    L.push('Рыночную цену и ROI не считаю.');
  }

  const buttons = [
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
  ];

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Кредиты (используется только в legacy/link.ts) ─────────────────────────

export function buildCreditsMessage(status: SubscriptionStatus): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const text = formatCreditsLine(status);
  const buttons: any[][] = [];

  if (status.creditsRemaining <= 0) {
    buttons.push([
      Markup.button.callback('10 · 150⭐', 'pay_pack10'),
      Markup.button.callback('30 · 300⭐', 'pay_pack30'),
      Markup.button.callback('7дн Pro · 500⭐', 'pay_week'),
    ]);
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Данные 1688 (по кнопке) ────────────────────────────────────────────────

export function build1688Detail(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const L: string[] = [];
  const normalized = product.normalized1688;

  L.push('📦 <b>Данные товара с 1688</b>');
  L.push('');

  // Названия
  L.push('<b>Название CN:</b>');
  L.push(esc(product.titleCn));
  if (product.titleRu) {
    L.push('');
    L.push('<b>Название RU:</b>');
    L.push(esc(product.titleRu));
  }

  // Цена
  L.push('');
  L.push('<b>Цена:</b>');
  L.push(`• цена для расчёта: ${product.priceYuan} ¥`);
  if (normalized?.pricing?.quoteType) L.push(`• quote_type: ${normalized.pricing.quoteType}`);
  if (normalized?.pricing?.rawPriceFields?.length) L.push(`• rawPriceFields: ${normalized.pricing.rawPriceFields.join(', ')}`);
  if (normalized?.pricing?.directPriceYuan) L.push(`• direct: ${normalized.pricing.directPriceYuan} ¥`);
  if (normalized?.pricing?.promotionPriceYuan) L.push(`• promotion: ${normalized.pricing.promotionPriceYuan} ¥`);
  if (product.priceRange?.length) {
    const valid = product.priceRange.filter((r) => r.minQty > 0);
    if (valid.length) {
      L.push('• скидки по количеству:');
      valid.slice(0, 4).forEach((r) => {
        const maxLabel = r.maxQty > 0 ? `–${r.maxQty}` : '+';
        L.push(`  ${r.minQty}${maxLabel} шт → ${r.price} ¥`);
      });
    } else {
      L.push('• скидки: не распознаны');
    }
  }

  // SKU
  if (product.skus?.length) {
    L.push('');
    L.push(`<b>SKU:</b> ${product.skus.length} вариантов`);
    const withPrice = product.skus.filter((s) => s.price && s.price > 0);
    if (withPrice.length) {
      const prices = withPrice.map((s) => s.price!);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      L.push(minP === maxP ? `• цена SKU: ${minP} ¥` : `• цена SKU: ${minP}–${maxP} ¥`);
    }
    const names = product.skus.slice(0, 6).map((s) => s.name).filter(Boolean);
    if (names.length) {
      L.push(`• варианты: ${names.join(', ')}${product.skus.length > 6 ? '…' : ''}`);
    }
    if (normalized?.pricing?.selectedSkuName) {
      L.push(`• selectedSku: ${esc(normalized.pricing.selectedSkuName)}`);
    }
  } else {
    L.push('');
    L.push('<b>SKU:</b> не найдены');
  }

  // Поставщик
  L.push('');
  L.push('<b>Поставщик:</b>');
  L.push(`• название: ${esc(product.supplierName)}`);
  L.push(`• тип: ${formatSupplierType(normalized?.supplierType ?? product.supplierType)}`);
  if (product.supplierRating) L.push(`• рейтинг: ${product.supplierRating}/5`);
  if (product.sold) L.push(`• заказов: ${fN(product.sold)}+`);
  if (normalized?.repurchaseRate) L.push(`• repurchase: ${esc(normalized.repurchaseRate)}`);
  L.push(`• MOQ: ${product.moq > 1 ? `${product.moq} шт` : 'не указано'}`);

  // Характеристики
  if (product.attributes?.length) {
    L.push('');
    L.push('<b>Характеристики:</b>');
    const shown = normalized?.keyAttributes?.length
      ? normalized.keyAttributes
      : product.attributes.slice(0, 5).map((a) => ({ label: a.name, value: a.value }));
    shown.forEach((a) => L.push(`• ${esc(a.label)}: ${esc(a.value)}`));
    if (product.attributes.length > shown.length) L.push(`<i>и ещё ${product.attributes.length - shown.length} атрибутов</i>`);
  }

  // Логистика
  L.push('');
  L.push('<b>Логистика:</b>');
  L.push(`• вес: ${product.weightKg > 0 ? `${product.weightKg} кг` : 'не указано'}`);
  L.push(`• фото: ${normalized?.imageCount ?? product.images?.length ?? 0} шт`);
  if (product.stock) L.push(`• остаток: ${fN(product.stock)} шт`);

  if (normalized?.debug) {
    L.push('');
    L.push('<b>Debug:</b>');
    L.push(`• quote_type: ${normalized.debug.quoteType}`);
    L.push(`• rawPriceFields: ${normalized.debug.rawPriceFields.join(', ') || 'нет'}`);
    L.push(`• skuCount: ${normalized.debug.skuCount}`);
    L.push(`• attributesCount: ${normalized.debug.attributesCount}`);
    L.push(`• imageCount: ${normalized.debug.imageCount}`);
    L.push(`• seller_type: ${normalized.debug.sellerType ?? 'не указано'}`);
    L.push(`• extra_info keys: ${normalized.debug.extraInfoKeys.join(', ') || 'нет'}`);
    L.push(`• missingCriticalFields: ${normalized.debug.missingCriticalFields.join(', ') || 'нет'}`);
  }

  const buttons = [
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
  ];

  return { text: sanitize(L.join('\n')), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Legacy exports ─────────────────────────────────────────────────────────

export const buildMessage1 = (product: ProductWithContent) => buildMainMessage(product, '').text;
export const buildMessage2 = (product: ProductWithContent, jobId: string) => buildMainMessage(product, jobId);
export const buildMessage3 = buildCreditsMessage;
