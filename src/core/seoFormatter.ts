import type { AiContentResult, RawProduct1688, RiskFlags } from '../types';

export function formatSeoText(
  product: RawProduct1688,
  content: AiContentResult,
  riskFlags?: RiskFlags
): string {
  const L: string[] = [];

  L.push('═══════════════════════════════════');
  L.push('   cardZip — МАТЕРИАЛЫ ДЛЯ WB');
  L.push('═══════════════════════════════════');
  L.push('');

  // Название
  L.push('📌 НАЗВАНИЕ ДЛЯ WB');
  L.push('─────────────────────');
  L.push(content.titleRu);
  L.push('');

  if (riskFlags?.hasBrand && content.titleRuBranded) {
    L.push('📌 ОРИГИНАЛЬНОЕ ОБОЗНАЧЕНИЕ ПОСТАВЩИКА');
    L.push('─────────────────────');
    L.push(content.titleRuBranded);
    L.push('⚠️ Бренд и модель не включены в название WB.');
    L.push('   Используйте их только при наличии прав на продажу.');
    L.push('');
  }

  // Описание
  L.push('📝 КРАТКОЕ ОПИСАНИЕ');
  L.push('─────────────────────');
  L.push(content.description);
  L.push('');

  // Буллеты
  if (content.bullets?.length) {
    L.push('🎯 5 БУЛЛЕТОВ');
    L.push('─────────────────────');
    content.bullets.forEach((b, i) => {
      L.push(`${i + 1}. ${b}`);
    });
    L.push('');
  }

  // Характеристики
  if (Object.keys(content.characteristics).length > 0) {
    L.push('📋 ХАРАКТЕРИСТИКИ');
    L.push('─────────────────────');
    Object.entries(content.characteristics).forEach(([key, value]) => {
      L.push(`${key}: ${value}`);
    });
    L.push('');
  }

  // Ключевые слова
  if (content.keywords?.length) {
    L.push('🔍 КЛЮЧЕВЫЕ СЛОВА');
    L.push('─────────────────────');
    L.push(content.keywords.join(', '));
    L.push('');
  }

  // Требует уточнения
  const missing: string[] = [];
  if (!product.weightKg || product.weightKg <= 0) missing.push('Вес товара с упаковкой');
  if (!product.supplierType) missing.push('Тип поставщика (фабрика / торговая компания)');
  if (riskFlags?.isElectrical) missing.push('Мощность, напряжение, тип питания, наличие аккумулятора');
  if (riskFlags?.sizeGridRelevant) missing.push('Размерная таблица в сантиметрах');
  if (riskFlags?.hasBrand) missing.push('Права на продажу бренда или возможность нейтральной упаковки');

  if (missing.length) {
    L.push('❓ ТРЕБУЕТ УТОЧНЕНИЯ У ПОСТАВЩИКА');
    L.push('─────────────────────');
    missing.forEach((m) => L.push(`• ${m}`));
    L.push('');
  }

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
