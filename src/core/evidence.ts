import type { RawProduct1688, AiContentResult, FieldEvidence } from '../types';

export function buildEvidence(product: RawProduct1688, content: AiContentResult): FieldEvidence[] {
  const evidence: FieldEvidence[] = [];

  evidence.push({
    field: 'Цена',
    value: `${product.priceYuan} ¥`,
    confidence: 'confirmed',
    source: 'product_attributes',
  });

  evidence.push({
    field: 'MOQ',
    value: product.moq,
    confidence: 'confirmed',
    source: 'product_attributes',
  });

  evidence.push({
    field: 'Вес',
    value: product.weightKg > 0 ? `${product.weightKg} кг` : 'не указан',
    confidence: product.weightKg > 0 ? 'confirmed' : 'unknown',
    source: 'product_attributes',
  });

  if (product.supplierType) {
    evidence.push({
      field: 'Тип поставщика',
      value: product.supplierType,
      confidence: 'confirmed',
      source: 'seller',
    });
  }

  // Характеристики от поставщика — confirmed
  (product.attributes ?? []).slice(0, 10).forEach((a) => {
    evidence.push({
      field: a.name,
      value: a.value,
      confidence: 'confirmed',
      source: 'product_attributes',
    });
  });

  // Переведённые характеристики от LLM — inferred
  Object.entries(content.characteristics).forEach(([k, v]) => {
    const fromSupplier = evidence.some((e) => e.field === k);
    if (!fromSupplier) {
      evidence.push({
        field: k,
        value: v,
        confidence: 'inferred',
        source: 'llm',
      });
    }
  });

  return evidence;
}
