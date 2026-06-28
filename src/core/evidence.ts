import type { RawProduct1688, AiContentResult, FieldEvidence } from '../types';
import { normalizeCnText } from './cnNormalize';
import { resolvePurchasePrice } from './priceResolver';

function isBadScalar(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  return !s || /^(undefined|null|nan)$/i.test(s);
}

function safeText(value: unknown, fallback = 'не указано'): string {
  if (isBadScalar(value)) return fallback;
  const normalized = normalizeCnText(String(value))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^(undefined|null|nan)$/i.test(normalized)) return fallback;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function pushEvidence(evidence: FieldEvidence[], item: FieldEvidence): void {
  const field = safeText(item.field, '');
  const value = safeText(item.value, '');
  if (!field || !value) return;
  evidence.push({ ...item, field, value });
}

export function buildEvidence(product: RawProduct1688, content: AiContentResult): FieldEvidence[] {
  const evidence: FieldEvidence[] = [];
  const normalized = product.normalized1688;
  const resolvedPrice = resolvePurchasePrice(product);

  pushEvidence(evidence, {
    field: 'Цена',
    value: resolvedPrice.valueCny != null ? resolvedPrice.displayLabel : 'не указана',
    confidence: resolvedPrice.valueCny != null ? (resolvedPrice.isEstimated ? 'inferred' : 'confirmed') : 'unknown',
    source: 'product_attributes',
  });

  const moq = positiveNumber(normalized?.moq ?? product.moq);
  pushEvidence(evidence, {
    field: 'MOQ',
    value: moq != null ? `${moq} шт.` : 'не указано',
    confidence: moq != null ? 'confirmed' : 'unknown',
    source: 'product_attributes',
  });

  const weightKg = positiveNumber(normalized?.weightKg ?? product.weightKg);
  pushEvidence(evidence, {
    field: 'Вес',
    value: weightKg != null ? `${Math.round(weightKg * 1000) / 1000} кг` : 'не указано',
    confidence: weightKg != null ? 'confirmed' : 'unknown',
    source: 'product_attributes',
  });

  const supplierType = normalized?.supplierType ?? product.supplierType;
  if (!isBadScalar(supplierType)) {
    pushEvidence(evidence, {
      field: 'Тип поставщика',
      value: supplierType!,
      confidence: 'confirmed',
      source: 'seller',
    });
  }

  // Характеристики от поставщика — confirmed, но без сырого undefined/null/NaN и с мягкой нормализацией китайских claim-слов.
  (normalized?.attributes ?? product.attributes ?? []).slice(0, 10).forEach((a) => {
    if (isBadScalar((a as any).name) || isBadScalar((a as any).value)) return;
    pushEvidence(evidence, {
      field: (a as any).name,
      value: (a as any).value,
      confidence: 'confirmed',
      source: 'product_attributes',
    });
  });

  // Переведённые характеристики от LLM — inferred. Не дублируем confirmed-поля.
  Object.entries(content.characteristics ?? {}).forEach(([k, v]) => {
    if (isBadScalar(k) || isBadScalar(v)) return;
    const key = safeText(k, '');
    const fromSupplier = evidence.some((e) => safeText(e.field, '').toLowerCase() === key.toLowerCase());
    if (!fromSupplier) {
      pushEvidence(evidence, {
        field: key,
        value: v,
        confidence: 'inferred',
        source: 'llm',
      });
    }
  });

  return evidence;
}
