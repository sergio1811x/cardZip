import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus } from '../types';
import { formatRiskMessages } from './riskFlags';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fP(n: number): string {
  return n.toLocaleString('ru-RU') + ' ₽';
}

function fN(n: number): string {
  return n.toLocaleString('ru-RU');
}

export function buildMessage1(product: ProductWithContent): string {
  const { wbFiltered, economics, score, verdict, riskFlags, testPurchase } = product;
  const L: string[] = [];
  const b = economics.breakdown;

  // ─── Заголовок + Score ─────────────────────────────────────────────────────
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');
  if (score.total !== null) {
    L.push(`📊 <b>Score: ${score.total}/100</b> → <b>${verdict.label}</b>`);
    score.reasons.forEach((r) => L.push(`  • ${r}`));
  } else {
    L.push(`<b>${verdict.label}</b>`);
    L.push('  Скоринг невозможен без данных с Wildberries.');
  }
  L.push('');

  // ─── Поставщик (компактно) ─────────────────────────────────────────────────
  const supplierParts: string[] = [];
  if (product.supplierType) {
    const t = { factory: 'Фабрика', merchant: 'Торговая компания', seller: 'Продавец' };
    supplierParts.push(t[product.supplierType]);
  }
  if (product.sold) supplierParts.push(`${fN(product.sold)}+ заказов`);
  if (product.supplierRating) supplierParts.push(`${product.supplierRating}/5`);
  L.push(`🏭 <b>Поставщик:</b> ${esc(product.supplierName)}${supplierParts.length ? ' · ' + supplierParts.join(' · ') : ''}`);
  L.push('');

  // ─── Рынок WB ─────────────────────────────────────────────────────────────
  L.push('🔍 <b>Рынок WB</b>');
  if (wbFiltered && (wbFiltered.quality === 'reliable' || wbFiltered.quality === 'limited')) {
    L.push(`  Карточек: ${wbFiltered.relevantCount} | Отзывов: ${fN(wbFiltered.totalFeedbacks)} | Рейтинг: ${wbFiltered.avgRating}`);
    L.push(`  Медиана: <b>${fP(wbFiltered.medianPrice)}</b> | Диапазон: ${fP(wbFiltered.p25Price)}–${fP(wbFiltered.p75Price)}`);
    if (wbFiltered.topExamples.length) {
      L.push('  Похожие:');
      wbFiltered.topExamples.forEach((ex) => {
        const shortTitle = ex.title.length > 40 ? ex.title.slice(0, 37) + '...' : ex.title;
        L.push(`  • <a href="${ex.url}">${fP(ex.price)}</a> — ${esc(shortTitle)}`);
      });
    }
    if (wbFiltered.quality === 'limited') {
      L.push('  <i>⚠️ Ограниченная выборка — проверьте вручную</i>');
    }
  } else {
    L.push('  ⚠️ Не удалось найти точных конкурентов по фото.');
    L.push('  Экономика рассчитана от рекомендуемой наценки.');
  }
  L.push('');

  // ─── Экономика (таблица) ───────────────────────────────────────────────────
  L.push('💰 <b>Юнит-экономика</b>');
  L.push(`  Закупка: ${b.purchaseYuan} ¥ × ${economics.yuanToRub.toFixed(2)} = ${fP(b.purchaseRub)}`);
  L.push(`  Банк ${3}%: +${fP(b.bankMarkupRub)}`);
  if (!economics.weightMissing) {
    L.push(`  Карго (${product.weightKg} кг): +${fP(b.cargoRub)}`);
    L.push(`  Внутренняя логистика: +${fP(b.internalLogisticsRub)}`);
  } else {
    L.push('  Карго: <i>вес не указан</i>');
  }
  L.push(`  <b>Себестоимость: ${fP(economics.costRub)}</b>`);
  L.push('');
  if (economics.isSyntheticPrice) {
    L.push(`  Целевая цена (при марже ~35%): ${fP(economics.avgSaleRub)} <i>⚠️ расчётная</i>`);
  } else {
    L.push(`  Цена продажи (медиана WB): ${fP(economics.avgSaleRub)}`);
  }
  L.push(`  Комиссия WB 20%: −${fP(b.wbCommissionRub)}`);
  L.push(`  Логистика WB: −${fP(b.wbLogisticsRub)}`);
  L.push(`  Налог ~7%: −${fP(b.taxRub)}`);
  L.push('');

  const profitSign = economics.grossProfitRub >= 0 ? '+' : '';
  L.push(`  <b>Чистая маржа: ${profitSign}${fP(economics.grossProfitRub)} (${economics.grossMarginPercent}%)</b>`);
  L.push(`  ROI: ${economics.roiPercent}%`);
  if (economics.recommendedPriceRub > 0 && !economics.weightMissing) {
    L.push(`  Рекомендуемая цена (при марже 35%): ${fP(economics.recommendedPriceRub)}`);
  }
  L.push('');

  // ─── Тестовая закупка ──────────────────────────────────────────────────────
  if (testPurchase) {
    L.push(`🧪 <b>Тестовая партия ${testPurchase.quantity} шт: ~${fP(testPurchase.testBudgetRub)}</b>`);
    L.push(`  Товар+карго: ${fP(testPurchase.goodsAndCargoRub)} | Резерв ${testPurchase.reservePercent}%: ${fP(testPurchase.reserveRub)}`);
    L.push('');
  }

  // ─── Риски и предупреждения ──────────────────────────────────────────────
  const aiWarnings = product.seoContent?.warnings ?? [];
  const staticRisks = formatRiskMessages(riskFlags);
  // Приоритет: AI warnings (релевантные), потом static (бренд, поставщик, вес, WB)
  const staticNonCategory = staticRisks.filter((r) =>
    r.includes('бренд') || r.includes('поставщик') || r.includes('Вес') || r.includes('WB')
  );
  const allWarnings = [...aiWarnings, ...staticNonCategory];
  if (allWarnings.length) {
    L.push('⚠️ <b>Проверить</b>');
    allWarnings.forEach((r) => L.push(`  • ${r}`));
    L.push('');
  }

  L.push(`<i>${esc(economics.disclaimer)}</i>`);

  return L.join('\n');
}

export function buildEconomicsKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📦 $3/кг', `cargo_3_${jobId}`),
      Markup.button.callback('📦 $4/кг', `cargo_4_${jobId}`),
      Markup.button.callback('📦 $5/кг', `cargo_5_${jobId}`),
    ],
    [
      Markup.button.callback('🚚 50₽', `ff_50_${jobId}`),
      Markup.button.callback('🚚 80₽', `ff_80_${jobId}`),
      Markup.button.callback('🚚 120₽', `ff_120_${jobId}`),
    ],
  ]);
}

export function buildMessage3(status: SubscriptionStatus): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  let text: string;

  if (status.plan === 'free') {
    const remaining = status.generationsLimit - status.generationsUsed;
    text = remaining > 0
      ? `Осталось: <b>${remaining} из ${status.generationsLimit}</b> бесплатных проверок.`
      : '❌ Бесплатные проверки исчерпаны.';
  } else {
    text = `✅ <b>${status.plan === 'seller' ? 'Seller' : 'Business'}</b> подписка активна`;
    if (status.activeUntil) text += ` до ${status.activeUntil.toLocaleDateString('ru-RU')}`;
  }

  const buttons = [
    [Markup.button.callback('🔄 Проверить ещё товар', 'new_search')],
    [
      Markup.button.callback('📩 Вопросы поставщику', 'supplier_questions'),
      Markup.button.callback('⚙️ Мои тарифы', 'edit_tariffs'),
    ],
    ...(status.plan === 'free' ? [[Markup.button.callback('🔥 Снять лимиты', 'upgrade')]] : []),
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
