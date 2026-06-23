import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus, WbFilteredResult } from '../types';
import { formatRiskMessages } from './riskFlags';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitize(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s]+/gi, '')
    .replace(/\/(?:tmp|var|home|Users)\/[^\s]+/g, '')
    .trim();
}

function fP(n: number): string {
  return n.toLocaleString('ru-RU') + ' ₽';
}

function fN(n: number): string {
  return n.toLocaleString('ru-RU');
}

const PLATFORM_LABELS: Record<string, string> = {
  '1688': 'Источник: 1688 · закупочная гипотеза',
  taobao: 'Источник: Taobao · розничная витрина',
  tmall: 'Источник: Tmall · брендовая розничная витрина',
};

// ─── WB Status ───────────────────────────────────────────────────────────────

function getWbStatusLabel(wbf: WbFilteredResult | null): string {
  if (!wbf || wbf.relevantCount === 0) return 'По текущему запросу похожие карточки не найдены';
  if (wbf.relevantCount < 10) return `Найдено ${wbf.relevantCount} похожих карточек. Выборка слишком мала для оценки рынка`;
  if (wbf.relevantCount < 30) return `Найдено ${wbf.relevantCount} карточек. Ориентир ограничен`;
  return `Найдено ${wbf.relevantCount} карточек. Можно использовать как предварительный ориентир`;
}

// ─── Сообщение 1 ─────────────────────────────────────────────────────────────

export function buildMessage1(product: ProductWithContent): string {
  const { wbFiltered, economics, conclusion, maxPurchasePrice } = product;
  const L: string[] = [];
  const b = economics.breakdown;
  const wm = economics.weightMissing;

  // Заголовок
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');
  L.push(`<i>${PLATFORM_LABELS[product.platform] ?? product.platform}</i>`);
  if (product.priceIsRange) {
    L.push('⚠️ <i>Цена зависит от варианта. Уточните у поставщика.</i>');
  }

  // Поставщик
  const parts: string[] = [];
  if (product.supplierType) {
    const t = { factory: 'Фабрика', merchant: 'Торговая компания', seller: 'Продавец' };
    parts.push(t[product.supplierType]);
  }
  if (product.sold) parts.push(`${fN(product.sold)}+ заказов`);
  if (product.supplierRating) parts.push(`${product.supplierRating}/5`);
  L.push(`🏭 ${esc(product.supplierName)}${parts.length ? ' · ' + parts.join(' · ') : ''}`);

  // Оптовые цены
  if (product.priceRange?.length) {
    const valid = product.priceRange.filter((r) => r.minQty > 0);
    if (valid.length) {
      L.push('');
      valid.slice(0, 3).forEach((r) => {
        const maxLabel = r.maxQty > 0 ? `–${r.maxQty}` : '+';
        L.push(`  ${r.minQty}${maxLabel} шт. → ${r.price} ¥`);
      });
    } else if (product.priceRange.length > 0) {
      const prices = product.priceRange.map((r) => r.price).filter(Boolean);
      if (prices.length) {
        L.push(`  Оптовая цена: от ${Math.min(...prices)} ¥`);
        L.push('  <i>Пороги количества не распознаны — уточните у поставщика.</i>');
      }
    }
  }
  L.push('');

  // WB ориентир
  L.push('🔍 <b>Рынок WB — ориентир</b>');
  L.push(`  ${getWbStatusLabel(wbFiltered)}`);

  if (wbFiltered && wbFiltered.relevantCount > 0 && wbFiltered.medianPrice > 0) {
    L.push(`  Медиана: <b>${fP(wbFiltered.medianPrice)}</b>`);
    L.push(`  Диапазон: ${fP(wbFiltered.p25Price)}–${fP(wbFiltered.p75Price)}`);
    if (wbFiltered.topExamples.length) {
      wbFiltered.topExamples.slice(0, 3).forEach((ex) => {
        const t = ex.title.length > 35 ? ex.title.slice(0, 32) + '...' : ex.title;
        L.push(`  • <a href="${ex.url}">${fP(ex.price)}</a> — ${esc(t)}`);
      });
    }
    if (wbFiltered.relevantCount < 10) {
      L.push('');
      const queries = wbFiltered.searchQueries?.slice(0, 3) ?? [];
      if (queries.length) {
        L.push('  ⚠️ Проверьте вручную:');
        queries.forEach((q) => L.push(`  • ${esc(q)}`));
      }
    }
  }
  L.push('');

  // Экономика
  if (economics.platformMode === 'full') {
    if (wm) {
      L.push('💰 <b>Экономика — неполная</b>');
      L.push(`  Себестоимость без карго: ${fP(economics.costRub)}`);
      if (wbFiltered && wbFiltered.medianPrice > 0) {
        L.push(`  Цена-ориентир WB: ${fP(wbFiltered.medianPrice)}`);
      }
      L.push('');
      L.push('🟡 <b>Статус: нужна проверка</b>');
      L.push('Вес товара с упаковкой не указан поставщиком.');
      L.push('До подтверждения веса бот не рассчитывает маржу, ROI, допустимую цену и итоговый бюджет.');
      L.push('');
      L.push('📦 Возможное карго при $4/кг:');
      [0.3, 0.5, 0.7].forEach((w) => {
        L.push(`  ${w} кг → ~${fP(Math.round(w * 4 * 95))}/шт.`);
      });
      L.push('<i>Это сценарий, не вес товара.</i>');
    } else {
      // Полная экономика
      L.push('💰 <b>Ориентировочная закупочная экономика</b>');
      L.push(`  Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
      L.push(`  Банк 3%: +${fP(b.bankMarkupRub)}`);
      L.push(`  Карго (${product.weightKg} кг): +${fP(b.cargoRub)}`);
      L.push(`  Фулфилмент: +${fP(b.internalLogisticsRub)}`);
      L.push(`  <b>Себестоимость: ${fP(economics.costRub)}</b>`);
      L.push('');

      if (!economics.isSyntheticPrice) {
        L.push(`  Цена продажи (медиана WB): ${fP(economics.avgSaleRub)}`);
        L.push(`  Комиссия WB 20%: −${fP(b.wbCommissionRub)}`);
        L.push(`  Логистика WB: −${fP(b.wbLogisticsRub)}`);
        L.push(`  Реклама (ДРР ${b.drrPercent}%): −${fP(b.drrRub)}`);
        L.push(`  Налог ~7%: −${fP(b.taxRub)}`);
        L.push('');
        const sign = economics.grossProfitRub >= 0 ? '+' : '';
        L.push(`  <b>Ориентировочная прибыль: ${sign}${fP(economics.grossProfitRub)} (${economics.grossMarginPercent}%)</b>`);
        L.push(`  ROI: ${economics.roiPercent}%`);
      } else {
        L.push('  <i>Для расчёта прибыли проверьте цену продажи на WB.</i>');
      }
    }
  } else if (economics.platformMode === 'sample_only') {
    L.push('💰 <b>Ориентир по цене образца</b>');
    L.push(`  Цена витрины: ${b.purchaseYuan} ¥ · розничная`);
    L.push(`  Ориентировочная стоимость образца: ~${fP(economics.costRub)}`);
    L.push('  <i>⚠️ Это не цена партии. Запросите цену на 20/50/100 шт.</i>');
  } else {
    L.push('💰 <b>Брендовый референс</b>');
    L.push(`  Цена витрины: ${b.purchaseYuan} ¥ (~${fP(b.purchaseRub)})`);
    L.push('  <i>⚠️ Не используйте как цену закупки. Найдите OEM-аналог на 1688.</i>');
  }
  L.push('');

  // Макс. закупочная цена — ТОЛЬКО если вес известен и цена не синтетическая
  if (maxPurchasePrice && !wm && !economics.isSyntheticPrice && economics.platformMode === 'full') {
    L.push('🎯 <b>Целевая закупочная цена</b>');
    L.push(`  Макс. цена (при марже ${maxPurchasePrice.targetMarginPercent}%): <b>${maxPurchasePrice.maxYuan.toFixed(1)} ¥</b>`);
    L.push(`  Текущая: ${maxPurchasePrice.currentYuan} ¥`);
    if (maxPurchasePrice.allowed) {
      L.push('  ✅ Текущая цена проходит');
    } else {
      const diff = (maxPurchasePrice.currentYuan - maxPurchasePrice.maxYuan).toFixed(1);
      L.push(`  ❌ Превышение: +${diff} ¥. Запросите оптовую цену.`);
    }
    L.push('');
  }

  // Вывод
  L.push(`${conclusion.icon} <b>${esc(conclusion.headline)}</b>`);
  conclusion.disclaimers.forEach((d) => L.push(`<i>⚠️ ${esc(d)}</i>`));
  L.push('');
  L.push(`<i>${esc(economics.disclaimer)}</i>`);

  return sanitize(L.join('\n'));
}

// ─── Сообщение 2 ─────────────────────────────────────────────────────────────

export function buildMessage2(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { riskFlags, budgets, economics, seoContent } = product;
  const L: string[] = [];
  const wm = economics.weightMissing;

  // Риски — макс. 6 пунктов без дублей
  const aiWarnings = seoContent?.warnings ?? [];
  const staticRisks = formatRiskMessages(riskFlags).filter((r) =>
    r.includes('бренд') || r.includes('поставщик') || r.includes('Вес') || r.includes('WB')
  );
  const seen = new Set<string>();
  const allWarnings: string[] = [];
  for (const w of [...aiWarnings, ...staticRisks]) {
    const key = w.toLowerCase().slice(0, 30);
    if (!seen.has(key)) {
      seen.add(key);
      allWarnings.push(w);
    }
  }
  if (allWarnings.length) {
    L.push('⚠️ <b>Подтвердите до оплаты</b>');
    allWarnings.slice(0, 6).forEach((r, i) => L.push(`${i + 1}. ${r}`));
    L.push('');
  }

  // Бюджеты
  if (budgets && economics.platformMode === 'full') {
    L.push('🧪 <b>Бюджет закупки</b>');
    if (wm) {
      L.push('🧪 <b>Бюджет — без карго</b>');
      [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
        L.push(`  ${s.label}, ${s.quantity} шт: ~${fP(s.goodsCostRub)} (товар+банк)`);
      });
      L.push('  <i>Карго не включено: нет веса.</i>');
    } else {
      [budgets.sample, budgets.test, budgets.firstBatch].forEach((s) => {
        L.push(`  ${s.label} — ${s.quantity} шт: ~<b>${fP(s.totalRub)}</b>${s.quantity > 1 ? ' (вкл. 15% резерв)' : ''}`);
      });
    }
    L.push('');
  } else if (economics.platformMode === 'sample_only' && budgets) {
    L.push('🧪 <b>Стоимость образца</b>');
    L.push(`  1 шт. по цене витрины: ~${fP(budgets.sample.totalRub)}`);
    L.push('  <i>Для партий 20/50/100 шт. нужна цена продавца.</i>');
    L.push('');
  }

  // Кнопки
  const buttons: any[][] = [
    [Markup.button.callback('📩 Вопросы поставщику', 'supplier_questions')],
  ];
  if (product.platform !== '1688') {
    buttons.push([Markup.button.callback('🔎 Найти аналог на 1688', `search_1688_${jobId}`)]);
  }
  if (economics.platformMode === 'full' && !wm) {
    buttons.push([
      Markup.button.callback('📦 $3/кг', `cargo_3_${jobId}`),
      Markup.button.callback('📦 $4/кг', `cargo_4_${jobId}`),
      Markup.button.callback('📦 $5/кг', `cargo_5_${jobId}`),
    ]);
  }

  return { text: L.join('\n'), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Сообщение 3 ─────────────────────────────────────────────────────────────

export function buildMessage3(status: SubscriptionStatus): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  let text: string;

  if (status.plan === 'free') {
    if (status.creditsRemaining > 0) {
      text = `🎁 Осталось: <b>${status.creditsRemaining} из ${status.creditsTotal}</b> бесплатных разборов.`;
    } else {
      text = '🔎 Бесплатные разборы использованы.';
    }
  } else if (status.plan === 'week') {
    text = `⚡ <b>Неделя активной закупки</b>`;
    if (status.activeUntil) text += ` до ${status.activeUntil.toLocaleDateString('ru-RU')}`;
    text += ` · осталось ${status.creditsRemaining} разборов`;
  } else {
    text = `📦 Осталось: <b>${status.creditsRemaining}</b> разборов`;
  }

  const buttons = [
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
    [
      Markup.button.callback('📩 Ответ поставщика', 'supplier_confirm'),
      Markup.button.callback('⚙️ Тарифы', 'edit_tariffs'),
    ],
  ];

  if (status.creditsRemaining <= 0 || status.plan === 'free') {
    buttons.push([
      Markup.button.callback('10 · 299₽', 'pay_pack10'),
      Markup.button.callback('30 · 599₽ ⭐', 'pay_pack30'),
      Markup.button.callback('7дн · 990₽', 'pay_week'),
    ]);
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
