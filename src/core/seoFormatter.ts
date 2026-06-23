import type { AiContentResult, RawProduct1688, RiskFlags } from '../types';

export function formatSeoText(
  product: RawProduct1688,
  content: AiContentResult,
  riskFlags?: RiskFlags
): string {
  const L: string[] = [];

  L.push('# CardZip — Материалы для WB');
  L.push('');

  // Safe Listing banner для Taobao/Tmall
  if (product.platform === 'taobao') {
    L.push('> ⚠️ Товар с Taobao (розница). SEO-контент — черновик. Перед публикацией уточните характеристики по образцу.');
    L.push('');
  } else if (product.platform === 'tmall') {
    L.push('> ⚠️ Товар с Tmall (бренд). НЕ используйте бренд в карточке WB без прав. Фото могут быть защищены авторским правом.');
    L.push('');
  }

  // Название
  L.push('## Название для WB');
  L.push('');
  L.push(content.titleRu);
  L.push('');

  if (riskFlags?.hasBrand && content.titleRuBranded) {
    L.push('### Оригинальное обозначение поставщика');
    L.push('');
    L.push(content.titleRuBranded);
    L.push('');
    L.push('> ⚠️ Бренд и модель не включены в название WB. Используйте только при наличии прав.');
    L.push('');
  }

  // Описание
  L.push('## Описание');
  L.push('');
  L.push(content.description);
  L.push('');

  // Буллеты
  if (content.bullets?.length) {
    L.push('## 5 буллетов для инфографики');
    L.push('');
    content.bullets.forEach((b, i) => {
      L.push(`${i + 1}. ${b}`);
    });
    L.push('');
  }

  // Характеристики
  if (Object.keys(content.characteristics).length > 0) {
    L.push('## Характеристики');
    L.push('');
    L.push('| Параметр | Значение |');
    L.push('|----------|----------|');
    Object.entries(content.characteristics).forEach(([key, value]) => {
      L.push(`| ${key} | ${value} |`);
    });
    L.push('');
  }

  // Ключевые слова
  if (content.keywords?.length) {
    L.push('## Ключевые слова');
    L.push('');
    L.push(content.keywords.join(', '));
    L.push('');
  }

  // Требует уточнения
  const missing: string[] = [];
  if (!product.weightKg || product.weightKg <= 0) missing.push('Вес товара с упаковкой');
  if (!product.supplierType) missing.push('Тип поставщика');
  if (riskFlags?.isElectrical) missing.push('Мощность, напряжение, тип питания');
  if (riskFlags?.sizeGridRelevant) missing.push('Размерная таблица в сантиметрах');
  if (riskFlags?.hasBrand) missing.push('Права на продажу бренда');

  if (missing.length) {
    L.push('## Требует уточнения');
    L.push('');
    missing.forEach((m) => L.push(`- ${m}`));
    L.push('');
  }

  if (content.isFallback) {
    L.push('> ⚠️ SEO-контент сгенерирован в упрощённом режиме. Отредактируйте перед публикацией.');
    L.push('');
  }

  L.push('---');
  L.push(`*Перед размещением карточки уточните характеристики выбранного SKU.*`);
  L.push(`*Сгенерировано: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}*`);
  L.push('*CardZip | @cardzip_bot*');

  return L.join('\n');
}
