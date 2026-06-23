import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus } from '../types';
import { formatRiskMessages } from './riskFlags';

const FALLBACK_RATE = 11.8;

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
  const { wbFiltered, economics, verdict, riskFlags, testPurchase } = product;
  const L: string[] = [];
  const rate = isFinite(economics.yuanToRub) && economics.yuanToRub > 0 ? economics.yuanToRub : FALLBACK_RATE;

  // ─── Заголовок ─────────────────────────────────────────────────────────────
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');

  // ─── Вердикт ───────────────────────────────────────────────────────────────
  L.push(`<b>${verdict.label}</b>`);
  verdict.reasons.forEach((r) => L.push(`• ${r}`));
  L.push('');

  // ─── Поставщик ─────────────────────────────────────────────────────────────
  const pName = product.platform === '1688' ? '1688' : product.platform === 'taobao' ? 'Taobao' : 'Tmall';
  L.push(`🏭 <b>Поставщик ${pName}</b>`);
  if (product.supplierName) L.push(`• ${esc(product.supplierName)}`);
  if (product.supplierType) {
    const t = { factory: '🏭 Фабрика', merchant: '🏪 Торговая компания', seller: '👤 Продавец' };
    L.push(`• Тип: ${t[product.supplierType]}`);
  }
  if (product.sold) L.push(`• Заказов: ${fN(product.sold)}+`);
  if (product.supplierRating) L.push(`• Рейтинг: ${product.supplierRating}/5`);

  const badges: string[] = [];
  if (product.supplierExtra?.dropshipping) badges.push('дропшиппинг');
  if (product.supplierExtra?.freeReturn7d) badges.push('возврат 7 дней');
  if (product.supplierExtra?.selectedSource) badges.push('отобранный источник');
  if (badges.length) L.push(`• ${badges.join(' | ')}`);
  L.push('');

  // ─── Закупка ───────────────────────────────────────────────────────────────
  L.push('📦 <b>Закупка</b>');
  const priceRub = Math.round(product.priceYuan * rate);
  L.push(`• Цена: <b>${product.priceYuan} ¥</b> (~${fP(priceRub)})`);

  if (product.priceRange?.length) {
    const valid = product.priceRange.filter((r) => r.minQty > 0);
    if (valid.length) {
      const ranges = valid.slice(0, 3).map((r) => `от ${r.minQty} шт. → ${r.price} ¥`);
      L.push(`• Опт: ${ranges.join(' | ')}`);
    }
  }

  L.push(`• MOQ: ${product.moq} шт.`);
  L.push(`• Вес: ${product.weightKg > 0 ? `${product.weightKg} кг` : '⚠️ не указан'}`);
  if (product.stock) L.push(`• Остаток: ${fN(product.stock)} шт.`);
  L.push('');

  // ─── Рынок WB ─────────────────────────────────────────────────────────────
  L.push('🔍 <b>Рынок Wildberries</b>');

  if (wbFiltered && wbFiltered.quality === 'reliable') {
    L.push(`Релевантные товары: ${wbFiltered.relevantCount} из ${wbFiltered.totalCount} найденных`);
    L.push(`Медианная цена: <b>${fP(wbFiltered.medianPrice)}</b>`);
    L.push(`Типичный диапазон: ${fP(wbFiltered.p25Price)}–${fP(wbFiltered.p75Price)}`);
    L.push(`Общий диапазон: ${fP(wbFiltered.minPrice)}–${fP(wbFiltered.maxPrice)}`);
    if (wbFiltered.topExamples.length) {
      L.push('');
      L.push('Похожие карточки:');
      wbFiltered.topExamples.forEach((ex) => {
        L.push(`• <a href="${ex.url}">${fP(ex.price)}</a>`);
      });
    }
  } else if (wbFiltered && wbFiltered.quality === 'limited') {
    L.push(`🟡 Данные ограничены: найдено ${wbFiltered.relevantCount} релевантных товаров.`);
    L.push(`Ориентир цены: ~<b>${fP(wbFiltered.medianPrice)}</b>`);
    L.push(`Типичный диапазон: ${fP(wbFiltered.p25Price)}–${fP(wbFiltered.p75Price)}`);
    L.push('');
    L.push('<i>Перед закупкой проверьте выдачу вручную.</i>');
  } else {
    L.push('⚠️ Автоматическая оценка рынка недостаточно точна.');
    L.push('В выдаче есть нерелевантные товары, выбросы или недостаточно данных.');
    if (wbFiltered?.searchQueries?.length) {
      L.push('');
      L.push('Подготовлены поисковые запросы для ручной проверки:');
      wbFiltered.searchQueries.forEach((q) => {
        const encoded = encodeURIComponent(q);
        L.push(`• <a href="https://www.wildberries.ru/catalog/0/search.aspx?search=${encoded}">🔎 ${esc(q)}</a>`);
      });
    }
  }
  L.push('');

  // ─── Экономика ─────────────────────────────────────────────────────────────
  L.push('📊 <b>Предварительная экономика</b>');
  L.push(`• Себестоимость в РФ: ~<b>${fP(economics.costRub)}</b>`);
  if (economics.weightMissing) {
    L.push('  <i>(без логистики — вес не указан)</i>');
  }
  L.push(`• Ориентир цены продажи: ~<b>${fP(economics.avgSaleRub)}</b>`);
  const p = economics.grossProfitRub;
  L.push(`• Валовая разница: <b>${p >= 0 ? '+' : '−'}${fP(Math.abs(p))}</b>`);
  L.push('');

  // ─── Тестовая закупка ──────────────────────────────────────────────────────
  if (testPurchase) {
    L.push(`🧪 <b>Тестовая закупка: ${testPurchase.quantity} шт.</b>`);
    L.push(`• Товар и карго: ~${fP(testPurchase.goodsAndCargoRub)}`);
    L.push(`• Резерв ${testPurchase.reservePercent}%: ~${fP(testPurchase.reserveRub)}`);
    L.push(`• Стартовый бюджет: ~<b>${fP(testPurchase.testBudgetRub)}</b>`);
    L.push('<i>Не включает комиссии WB, рекламу, упаковку, налоги, возвраты и хранение.</i>');
    L.push('');
  }

  // ─── Риски ─────────────────────────────────────────────────────────────────
  const riskMessages = formatRiskMessages(riskFlags);
  if (riskMessages.length) {
    L.push('⚠️ <b>Риски и что проверить</b>');
    riskMessages.forEach((r) => L.push(`• ${r}`));
    L.push('');
  }

  // ─── Дисклеймер ────────────────────────────────────────────────────────────
  L.push(`<i>${esc(economics.disclaimer)}</i>`);

  return L.join('\n');
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
    [Markup.button.callback('📩 Вопросы поставщику', 'supplier_questions')],
    ...(status.plan === 'free' ? [[Markup.button.callback('🔥 Снять лимиты', 'upgrade')]] : []),
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
