import type { AiContentResult, RawProduct1688 } from '../types';

/**
 * Форматирует содержимое wb_seo.txt для отправки в Telegram как документ.
 */
export function formatSeoText(
  product: RawProduct1688,
  content: AiContentResult
): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════');
  lines.push('   cardZip — МАТЕРИАЛЫ ДЛЯ WB');
  lines.push('═══════════════════════════════════');
  lines.push('');

  lines.push('📌 НАЗВАНИЕ КАРТОЧКИ');
  lines.push('─────────────────────');
  lines.push(content.titleRu);
  lines.push('');

  lines.push('📝 ОПИСАНИЕ');
  lines.push('─────────────────────');
  lines.push(content.description);
  lines.push('');

  lines.push('🔍 КЛЮЧЕВЫЕ СЛОВА (для поиска)');
  lines.push('─────────────────────');
  content.keywords.forEach((kw, i) => {
    lines.push(`${i + 1}. ${kw}`);
  });
  lines.push('');

  if (Object.keys(content.characteristics).length > 0) {
    lines.push('📋 ХАРАКТЕРИСТИКИ КАРТОЧКИ');
    lines.push('─────────────────────');
    Object.entries(content.characteristics).forEach(([key, value]) => {
      lines.push(`${key}: ${value}`);
    });
    lines.push('');
  }

  lines.push('📦 ДАННЫЕ ПОСТАВЩИКА (1688)');
  lines.push('─────────────────────');
  lines.push(`Поставщик: ${product.supplierName}`);
  if (product.supplierRating) lines.push(`Рейтинг: ${product.supplierRating}`);
  lines.push(`Цена: ${product.priceYuan} ¥`);
  lines.push(`MOQ: ${product.moq} шт.`);
  lines.push(`Вес: ${product.weightKg} кг`);
  lines.push('');

  if (content.isFallback) {
    lines.push('⚠️  Примечание: SEO-контент сгенерирован в упрощённом режиме.');
    lines.push('    Рекомендуем отредактировать описание перед публикацией.');
    lines.push('');
  }

  lines.push('─────────────────────');
  lines.push(`Сгенерировано: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`);
  lines.push('cardZip | @cardzip_bot');

  return lines.join('\n');
}
