import { Markup } from 'telegraf';
import type { ProductWithContent, SubscriptionStatus } from '../types';

function formatPrice(n: number): string {
  return n.toLocaleString('ru-RU') + ' ₽';
}

/**
 * Сообщение 1: аналитика + юнит-экономика
 */
export function buildMessage1(product: ProductWithContent): string {
  const { wbData, economics } = product;
  const lines: string[] = [];

  lines.push(`📦 <b>${escHtml(product.titleRu)}</b>`);
  lines.push('');

  // Данные поставщика
  lines.push('🏭 <b>Поставщик (1688)</b>');
  lines.push(`Название (кит.): ${escHtml(product.titleCn)}`);
  lines.push(`Цена: <b>${product.priceYuan} ¥</b>`);
  lines.push(`MOQ: ${product.moq} шт.`);
  lines.push(`Вес: ${product.weightKg} кг`);
  if (product.supplierName) lines.push(`Поставщик: ${escHtml(product.supplierName)}`);
  if (product.supplierRating) lines.push(`Рейтинг: ${product.supplierRating}/5`);
  lines.push('');
  lines.push('⚠️ <i>Размерная сетка может отличаться от российской. Уточняй у поставщика.</i>');
  lines.push('');

  // WB статистика
  if (wbData) {
    lines.push('📊 <b>Wildberries — похожие товары</b>');
    lines.push(`Средняя цена: <b>${formatPrice(wbData.avgPrice)}</b>`);
    lines.push(`Диапазон: ${formatPrice(wbData.minPrice)} — ${formatPrice(wbData.maxPrice)}`);
    lines.push(`Карточек в выдаче: ${wbData.totalCards.toLocaleString('ru-RU')}`);
    if (wbData.topExamples.length) {
      lines.push('');
      lines.push('Топ примеры:');
      wbData.topExamples.forEach((ex, i) => {
        lines.push(`${i + 1}. <a href="${ex.url}">${escHtml(ex.title.slice(0, 50))}</a> — ${formatPrice(ex.price)}`);
      });
    }
  } else {
    lines.push('📊 <i>Данные WB временно недоступны</i>');
  }
  lines.push('');

  // Юнит-экономика
  lines.push('💰 <b>Предварительная юнит-экономика</b>');
  lines.push(`Себестоимость в РФ: <b>${formatPrice(economics.costRub)}</b>`);
  lines.push(`Ср. цена продажи: <b>${formatPrice(economics.avgSaleRub)}</b>`);
  const profit = economics.grossProfitRub;
  const profitStr = formatPrice(Math.abs(profit));
  lines.push(`Валовая прибыль: <b>${profit >= 0 ? '+' : '−'}${profitStr}</b>`);
  lines.push('');
  lines.push(`<i>${escHtml(economics.disclaimer)}</i>`);

  return lines.join('\n');
}

/**
 * Сообщение 3: счётчик + кнопки
 */
export function buildMessage3(status: SubscriptionStatus): {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
} {
  let text: string;

  if (status.plan === 'free') {
    const remaining = status.generationsLimit - status.generationsUsed;
    text = remaining > 0
      ? `🎁 Осталось бесплатных генераций: <b>${remaining}</b> из ${status.generationsLimit}`
      : `❌ Бесплатные генерации исчерпаны`;
  } else {
    text = `✅ <b>${status.plan === 'seller' ? 'Seller' : 'Business'}</b> подписка активна`;
    if (status.activeUntil) {
      const until = status.activeUntil.toLocaleDateString('ru-RU');
      text += ` до ${until}`;
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Проверить другой товар', 'new_search')],
    ...(status.plan === 'free' ? [[Markup.button.callback('🚀 Снять лимиты', 'upgrade')]] : []),
    [Markup.button.callback('📋 Последний товар /last', 'last')],
  ]);

  return { text, keyboard };
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
