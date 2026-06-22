import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus } from '../types';

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
  const { wbData, economics, verdict } = product;
  const L: string[] = [];
  const rate = isFinite(economics.yuanToRub) && economics.yuanToRub > 0 ? economics.yuanToRub : FALLBACK_RATE;

  // ─── Заголовок ─────────────────────────────────────────────────────────────
  L.push(`📦 <b>${esc(product.titleRu)}</b>`);
  L.push('');

  // ─── Вердикт ───────────────────────────────────────────────────────────────
  L.push(`<b>${verdict.label}</b>`);
  verdict.reasons.forEach((r) => L.push(`• ${r}`));
  L.push('');

  // ─── Фабрика ───────────────────────────────────────────────────────────────
  const pName = product.platform === '1688' ? '1688' : product.platform === 'taobao' ? 'Taobao' : 'Tmall';
  L.push(`🏭 <b>Фабрика ${pName}</b>`);
  if (product.supplierName) L.push(`• ${esc(product.supplierName)}`);
  if (product.supplierType) {
    const t = { factory: '🏭 Фабрика', merchant: '🏪 Торговая компания', seller: '👤 Продавец' };
    L.push(`• Тип: ${t[product.supplierType]}`);
  }
  if (product.sold) L.push(`• Заказов: ${fN(product.sold)}+`);
  if (product.supplierRating) L.push(`• Рейтинг: ${product.supplierRating}/5`);

  // extra_info бейджи
  const badges: string[] = [];
  if (product.supplierExtra?.dropshipping) badges.push('дропшиппинг');
  if (product.supplierExtra?.freeReturn7d) badges.push('возврат 7 дней');
  if (product.supplierExtra?.selectedSource) badges.push('отобранный источник');
  if (badges.length) L.push(`• ${badges.join(' | ')}`);
  L.push('');

  // ─── Закупка ───────────────────────────────────────────────────────────────
  L.push('📦 <b>Закупка</b>');
  const priceRub = Math.round(product.priceYuan * rate);
  L.push(`Цена: <b>${product.priceYuan} ¥</b> (~${fP(priceRub)})`);

  if (product.priceRange?.length) {
    const valid = product.priceRange.filter((r) => r.minQty > 0);
    if (valid.length) {
      const ranges = valid.slice(0, 3).map((r) => `от ${r.minQty} шт. → ${r.price} ¥`);
      L.push(`Опт: ${ranges.join(' | ')}`);
    }
  }

  L.push(`Мин. заказ: ${product.moq} шт.`);
  L.push(`Вес: ${product.weightKg > 0 ? `${product.weightKg} кг` : 'лёгкий товар (до 0.1 кг)'}`);
  if (product.stock) L.push(`На складе: ${fN(product.stock)} шт.`);
  L.push('');

  L.push('⚠️ <i>Размерная сетка поставщика отличается от РФ. Уточняйте таблицу размеров у фабрики перед закупкой.</i>');
  L.push('');

  // ─── WB аналитика ─────────────────────────────────────────────────────────
  if (wbData) {
    L.push('🔍 <b>Рынок Wildberries</b>');
    L.push(`Найдено карточек: <b>${fN(wbData.totalCards)}</b>`);
    L.push(`Средняя цена: <b>${fP(wbData.avgPrice)}</b>`);
    L.push(`Диапазон: ${fP(wbData.minPrice)} — ${fP(wbData.maxPrice)}`);
    L.push('');
    if (wbData.topExamples.length) {
      L.push('Топ похожих:');
      wbData.topExamples.forEach((ex) => {
        L.push(`• <a href="${ex.url}">${fP(ex.price)}</a>`);
      });
      L.push('');
    }
  } else {
    L.push('🔍 <i>Данные WB временно недоступны</i>');
    L.push('');
  }

  // ─── Юнит-экономика ───────────────────────────────────────────────────────
  L.push('📊 <b>Предварительная экономика</b>');
  L.push(`Себестоимость в РФ: ~<b>${fP(economics.costRub)}</b>`);
  L.push(`Средняя цена продажи: ~<b>${fP(economics.avgSaleRub)}</b>`);
  const p = economics.grossProfitRub;
  L.push(`Потенциальная валовая прибыль: <b>${p >= 0 ? '≈+' : '≈−'}${fP(Math.abs(p))}</b>`);
  L.push('');
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
      ? `⚠️ Осталось: <b>${remaining} из ${status.generationsLimit}</b> бесплатных генераций.`
      : '❌ Бесплатные генерации исчерпаны.';
    text += '\n\n❓ Хотите проверить ещё один товар?';
  } else {
    text = `✅ <b>${status.plan === 'seller' ? 'Seller' : 'Business'}</b> подписка активна`;
    if (status.activeUntil) text += ` до ${status.activeUntil.toLocaleDateString('ru-RU')}`;
    text += '\n\n❓ Хотите проверить ещё один товар?';
  }

  const buttons = [
    [Markup.button.callback('🔄 Да, отправить ссылку', 'new_search')],
    ...(status.plan === 'free' ? [[Markup.button.callback('🔥 Снять лимиты', 'upgrade')]] : []),
    [Markup.button.callback('📋 Последний анализ', 'last')],
  ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
