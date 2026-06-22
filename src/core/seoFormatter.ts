import type { AiContentResult, RawProduct1688 } from '../types';

export function formatSeoText(
  product: RawProduct1688,
  content: AiContentResult
): string {
  const L: string[] = [];

  L.push('═══════════════════════════════════');
  L.push('   cardZip — МАТЕРИАЛЫ ДЛЯ WB');
  L.push('═══════════════════════════════════');
  L.push('');

  L.push('📌 НАЗВАНИЕ КАРТОЧКИ');
  L.push('─────────────────────');
  L.push(content.titleRu);
  L.push('');

  L.push('📝 ОПИСАНИЕ');
  L.push('─────────────────────');
  L.push(content.description);
  L.push('');

  if (content.bullets?.length) {
    L.push('🎯 5 БУЛЛЕТОВ ДЛЯ ИНФОГРАФИКИ');
    L.push('─────────────────────');
    content.bullets.forEach((b, i) => {
      L.push(`${i + 1}. ${b}`);
    });
    L.push('');
  }

  L.push('🔍 КЛЮЧЕВЫЕ СЛОВА');
  L.push('─────────────────────');
  content.keywords.forEach((kw, i) => {
    L.push(`${i + 1}. ${kw}`);
  });
  L.push('');

  if (Object.keys(content.characteristics).length > 0) {
    L.push('📋 ХАРАКТЕРИСТИКИ КАРТОЧКИ');
    L.push('─────────────────────');
    Object.entries(content.characteristics).forEach(([key, value]) => {
      L.push(`${key}: ${value}`);
    });
    L.push('');
  }

  L.push('📦 ДАННЫЕ ПОСТАВЩИКА');
  L.push('─────────────────────');
  if (product.supplierName) L.push(`Поставщик: ${product.supplierName}`);
  if (product.supplierRating) L.push(`Рейтинг: ${product.supplierRating}/5`);
  L.push(`Цена: ${product.priceYuan} ¥`);
  L.push(`Мин. заказ: ${product.moq} шт.`);
  L.push(`Вес: ${product.weightKg > 0 ? `${product.weightKg} кг` : 'лёгкий товар (до 0.1 кг)'}`);
  if (product.sold) L.push(`Продажи: ${product.sold}+ заказов`);
  L.push('');

  if (content.isFallback) {
    L.push('⚠️ SEO-контент сгенерирован в упрощённом режиме.');
    L.push('   Рекомендуем отредактировать описание перед публикацией.');
    L.push('');
  }

  L.push('─────────────────────');
  L.push(`Сгенерировано: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`);
  L.push('cardZip | @cardzip_bot');

  return L.join('\n');
}
