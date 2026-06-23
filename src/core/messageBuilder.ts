import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus } from '../types';
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

// ─── Сообщение 1: Товар + WB ориентир + Экономика + Вывод ───────────────────

export function buildMessage1(product: ProductWithContent): string {
  const { wbFiltered, economics, conclusion, maxPurchasePrice } = product;
  const L: string[] = [];
  const b = economics.breakdown;

  // Заголовок
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');
  L.push(`<i>${PLATFORM_LABELS[product.platform] ?? product.platform}</i>`);
  if (product.priceIsRange) {
    L.push('⚠️ <i>Цена может зависеть от варианта (цвет/размер/комплектация). Уточните у поставщика.</i>');
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
  L.push('');

  // WB ориентир
  L.push('🔍 <b>Рынок WB — ориентир</b>');
  if (wbFiltered && wbFiltered.relevantCount >= 10 && (wbFiltered.quality === 'reliable' || wbFiltered.quality === 'limited')) {
    L.push(`  Выборка: ${wbFiltered.relevantCount} карточек`);
    L.push(`  Медиана: <b>${fP(wbFiltered.medianPrice)}</b>`);
    L.push(`  Диапазон: ${fP(wbFiltered.p25Price)}–${fP(wbFiltered.p75Price)}`);
    if (wbFiltered.topExamples.length) {
      L.push('  Похожие:');
      wbFiltered.topExamples.forEach((ex) => {
        const t = ex.title.length > 35 ? ex.title.slice(0, 32) + '...' : ex.title;
        L.push(`  • <a href="${ex.url}">${fP(ex.price)}</a> — ${esc(t)}`);
      });
    }
    if (wbFiltered.quality === 'limited') {
      L.push('  <i>⚠️ Ограниченная выборка — проверьте вручную</i>');
    }
  } else if (wbFiltered && wbFiltered.relevantCount > 0 && wbFiltered.relevantCount < 10) {
    L.push(`  ⚠️ Найдено ${wbFiltered.relevantCount} карточек — недостаточно для ориентира`);
  } else {
    L.push('  ⚠️ Не удалось найти точных аналогов по фото');
  }
  L.push('');

  // Экономика
  if (economics.platformMode === 'full') {
    L.push('💰 <b>Ориентировочная закупочная экономика</b>');
    L.push(`  Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
    L.push(`  Банк ${3}%: +${fP(b.bankMarkupRub)}`);
    if (!economics.weightMissing) {
      L.push(`  Карго (${product.weightKg} кг): +${fP(b.cargoRub)}`);
      L.push(`  Фулфилмент: +${fP(b.internalLogisticsRub)}`);
    } else {
      L.push('  Карго: <i>вес не указан</i>');
    }
    L.push(`  <b>Себестоимость до WB: ${fP(economics.costRub)}</b>`);
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
      L.push('  <i>Для расчёта прибыли проверьте цену продажи на WB вручную.</i>');
    }
  } else if (economics.platformMode === 'sample_only') {
    L.push('💰 <b>Ориентир по цене образца</b>');
    L.push(`  Цена витрины: ${b.purchaseYuan} ¥`);
    L.push(`  Статус цены: розничная`);
    L.push(`  Ориентировочная стоимость образца с доставкой: ~${fP(economics.costRub)}`);
    L.push('');
    L.push('  <i>⚠️ Это не цена партии. Запросите цену на 20/50/100 шт.</i>');
  } else {
    L.push('💰 <b>Брендовый референс</b>');
    L.push(`  Цена витрины: ${b.purchaseYuan} ¥ (~${fP(b.purchaseRub)})`);
    L.push('');
    L.push('  <i>⚠️ Не используйте как цену закупки. Найдите OEM-аналог на 1688.</i>');
  }
  L.push('');

  // Макс. закупочная цена
  if (maxPurchasePrice && economics.platformMode === 'full') {
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

// ─── Сообщение 2: Риски + Бюджеты + Кнопки ─────────────────────────────────

export function buildMessage2(product: ProductWithContent, jobId: string): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  const { riskFlags, budgets, economics, seoContent } = product;
  const L: string[] = [];

  // Риски
  const aiWarnings = seoContent?.warnings ?? [];
  const staticRisks = formatRiskMessages(riskFlags).filter((r) =>
    r.includes('бренд') || r.includes('поставщик') || r.includes('Вес') || r.includes('WB')
  );
  const allWarnings = [...aiWarnings, ...staticRisks];
  if (allWarnings.length) {
    L.push('⚠️ <b>Что проверить</b>');
    allWarnings.slice(0, 5).forEach((r) => L.push(`• ${r}`));
    L.push('');
  }

  // Бюджеты
  if (budgets && economics.platformMode === 'full') {
    L.push('🧪 <b>Бюджет закупки</b>');
    L.push(`  Образец — ${budgets.sample.quantity} шт: ~<b>${fP(budgets.sample.totalRub)}</b>`);
    L.push(`  Тест — ${budgets.test.quantity} шт: ~<b>${fP(budgets.test.totalRub)}</b> (вкл. 15% резерв)`);
    L.push(`  Первая партия — ${budgets.firstBatch.quantity} шт: ~<b>${fP(budgets.firstBatch.totalRub)}</b> (вкл. 15% резерв)`);
    if (budgets.weightMissing) {
      L.push('  <i>⚠️ Вес не указан — карго не учтено</i>');
    }
  } else if (economics.platformMode === 'sample_only' && budgets) {
    L.push('🧪 <b>Стоимость образца</b>');
    L.push(`  1 шт. по цене витрины: ~${fP(budgets.sample.totalRub)}`);
    L.push('  <i>Для партий 20/50/100 шт. нужна цена продавца.</i>');
  }

  // Кнопки
  const buttons: any[][] = [
    [Markup.button.callback('📩 Вопросы поставщику', 'supplier_questions')],
  ];

  if (product.platform !== '1688') {
    buttons.push([Markup.button.callback('🔎 Найти аналог на 1688', `search_1688_${jobId}`)]);
  }

  if (economics.platformMode === 'full') {
    buttons.push([
      Markup.button.callback('📦 $3/кг', `cargo_3_${jobId}`),
      Markup.button.callback('📦 $4/кг', `cargo_4_${jobId}`),
      Markup.button.callback('📦 $5/кг', `cargo_5_${jobId}`),
    ]);
  }

  return { text: L.join('\n'), keyboard: Markup.inlineKeyboard(buttons) };
}

// ─── Сообщение 3: Файлы + Лимиты + Кнопки ──────────────────────────────────

export function buildMessage3(status: SubscriptionStatus): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  let text: string;

  if (status.plan === 'free') {
    const remaining = status.generationsLimit - status.generationsUsed;
    text = remaining > 0
      ? `Осталось: <b>${remaining} из ${status.generationsLimit}</b> бесплатных разборов.`
      : '❌ Бесплатные разборы исчерпаны.';
  } else {
    text = `✅ <b>${status.plan === 'seller' ? 'Seller' : 'Business'}</b> подписка активна`;
    if (status.activeUntil) text += ` до ${status.activeUntil.toLocaleDateString('ru-RU')}`;
  }

  const buttons = [
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
    [Markup.button.callback('⚙️ Настройки экономики', 'edit_tariffs')],
    ...(status.plan === 'free' ? [[Markup.button.callback('⚡ Получить больше разборов', 'upgrade')]] : []),
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
