import type {
  ProductAttribute,
  ProductFact,
  ProductFactConflict,
  ProductFactSheet,
  ProductSku,
  RawProduct1688,
} from '../types';

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildFact(
  key: string,
  label: string,
  value: unknown,
  options: {
    unit?: string;
    status?: ProductFact['status'];
    confidence?: number;
    path: string;
    snippet?: string;
    notes?: string[];
  },
): ProductFact {
  const normalizedValue = normalizeText(value);
  return {
    key,
    label,
    value: (value ?? null) as ProductFact['value'],
    normalizedValue,
    unit: options.unit,
    status: options.status ?? (normalizedValue ? 'extracted' : 'unknown'),
    confidence: options.confidence ?? (normalizedValue ? 0.8 : 0.1),
    notes: options.notes,
    sources: [
      {
        source: key === 'supplier_type' ? 'seller' : 'attribute',
        path: options.path,
        snippet: normalizeText(options.snippet ?? value),
        confidence: options.confidence ?? 0.8,
      },
    ],
  };
}

function findAttribute(attributes: ProductAttribute[] | undefined, regex: RegExp): ProductAttribute | null {
  for (const attr of attributes ?? []) {
    if (regex.test(normalizeText(attr.name))) return attr;
  }
  return null;
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function buildConflicts(product: RawProduct1688, facts: ProductFact[]): ProductFactConflict[] {
  const conflicts: ProductFactConflict[] = [];
  const skuNames = uniqueValues([
    ...(product.skus ?? []).map((sku: ProductSku) => sku.name),
    ...((product.normalized1688?.skuVariants ?? []).map((sku) => sku.name)),
  ]);
  const selectedSku = normalizeText(product.selectedSkuName);
  if (selectedSku && skuNames.length > 0 && !skuNames.some((name) => name.toLowerCase() === selectedSku.toLowerCase())) {
    conflicts.push({
      key: 'selected_sku',
      label: 'Выбранный SKU',
      values: [selectedSku, ...skuNames.slice(0, 3)],
      reason: 'Выбранный SKU не найден в списке вариантов.',
      severity: 'high',
    });
  }

  const weightFact = facts.find((fact) => fact.key === 'weight_kg');
  const dimensionsFact = facts.find((fact) => fact.key === 'dimensions_cm');
  const dimensionsText = normalizeText(dimensionsFact?.value);
  if (weightFact && weightFact.status !== 'unknown' && /\b\d{2,3}\s*[×x*]\s*\d{2,3}\s*[×x*]\s*\d{2,3}\b/.test(dimensionsText)) {
    const note = normalizeText(weightFact.normalizedValue ?? weightFact.value);
    if (note) {
      conflicts.push({
        key: 'shipping_dimensions_basis',
        label: 'Габариты для логистики',
        values: [dimensionsText, note],
        reason: 'Нужно различать размеры товара в использовании и размеры упаковки для карго.',
        severity: 'medium',
      });
    }
  }

  return conflicts;
}

export function buildProductFactSheet(product: RawProduct1688): ProductFactSheet {
  const normalized = product.normalized1688;
  const attributes = normalized?.attributes ?? product.attributes ?? [];
  const weightAttr = findAttribute(attributes, /(重量|вес|weight)/i);
  const materialAttr = findAttribute(attributes, /(材质|материал|material)/i);
  const dimensionsAttr = findAttribute(attributes, /(尺寸|размер|габарит|dimension)/i);
  const loadAttr = findAttribute(attributes, /(承重|нагруз|load)/i);

  const facts: ProductFact[] = [
    buildFact('title_cn', 'Название CN', product.titleCn, {
      path: 'raw.titleCn',
      status: normalizeText(product.titleCn) ? 'confirmed' : 'unknown',
      confidence: 0.95,
    }),
    buildFact('supplier_name', 'Поставщик', product.supplierName, {
      path: 'raw.supplierName',
      status: normalizeText(product.supplierName) ? 'confirmed' : 'unknown',
      confidence: 0.95,
    }),
    buildFact('supplier_type', 'Тип поставщика', normalized?.supplierType ?? product.supplierType ?? '', {
      path: 'normalized1688.supplierType',
      status: normalized?.supplierType || product.supplierType ? 'confirmed' : 'unknown',
      confidence: 0.9,
    }),
    buildFact('price_cny', 'Цена', normalized?.pricing?.selectedSkuPriceYuan ?? normalized?.pricing?.displayPriceYuan ?? product.priceYuan, {
      path: 'normalized1688.pricing',
      unit: '¥',
      status: asNumber(normalized?.pricing?.selectedSkuPriceYuan ?? normalized?.pricing?.displayPriceYuan ?? product.priceYuan) ? 'confirmed' : 'unknown',
      confidence: 0.95,
    }),
    buildFact('moq', 'MOQ', normalized?.moq ?? product.moq, {
      path: 'normalized1688.moq',
      unit: 'шт.',
      status: asNumber(normalized?.moq ?? product.moq) ? 'confirmed' : 'unknown',
      confidence: 0.9,
    }),
    buildFact('selected_sku', 'Выбранный SKU', product.selectedSkuName ?? '', {
      path: 'raw.selectedSkuName',
      status: normalizeText(product.selectedSkuName) ? 'extracted' : 'supplier_pending',
      confidence: 0.85,
    }),
    buildFact('weight_kg', 'Вес товара', weightAttr?.value ?? normalized?.weightKg ?? product.weightKg ?? '', {
      path: weightAttr ? `attributes.${weightAttr.name}` : 'normalized1688.weightKg',
      unit: 'кг',
      status: asNumber(weightAttr?.value ?? normalized?.weightKg ?? product.weightKg) ? 'extracted' : 'unknown',
      confidence: weightAttr ? 0.88 : 0.72,
      notes: ['Вес товара не равен весу с упаковкой.'],
    }),
    buildFact('material', 'Материал', materialAttr?.value ?? '', {
      path: materialAttr ? `attributes.${materialAttr.name}` : 'attributes',
      status: normalizeText(materialAttr?.value) ? 'extracted' : 'unknown',
      confidence: materialAttr ? 0.86 : 0.2,
    }),
    buildFact('dimensions_cm', 'Размеры товара', dimensionsAttr?.value ?? '', {
      path: dimensionsAttr ? `attributes.${dimensionsAttr.name}` : 'attributes',
      status: normalizeText(dimensionsAttr?.value) ? 'extracted' : 'unknown',
      confidence: dimensionsAttr ? 0.82 : 0.2,
      notes: ['Размеры товара нельзя автоматически использовать как размеры упаковки.'],
    }),
    buildFact('max_load', 'Максимальная нагрузка', loadAttr?.value ?? '', {
      path: loadAttr ? `attributes.${loadAttr.name}` : 'attributes',
      status: normalizeText(loadAttr?.value) ? 'extracted' : 'supplier_pending',
      confidence: loadAttr ? 0.82 : 0.15,
    }),
  ];

  const missingRequired = facts
    .filter((fact) => ['selected_sku', 'price_cny', 'weight_kg', 'material'].includes(fact.key))
    .filter((fact) => fact.status === 'unknown' || fact.status === 'supplier_pending')
    .map((fact) => fact.label);

  const conflicts = buildConflicts(product, facts);
  const hasHighConflict = conflicts.some((conflict) => conflict.severity === 'high');

  return {
    facts,
    conflicts,
    missingRequired,
    summary: {
      confidence: hasHighConflict || missingRequired.length >= 3 ? 'low' : missingRequired.length ? 'medium' : 'high',
      blockingIssues: [
        ...missingRequired.map((label) => `Не подтверждено поле: ${label}`),
        ...conflicts.filter((conflict) => conflict.severity === 'high').map((conflict) => conflict.reason),
      ],
    },
  };
}
