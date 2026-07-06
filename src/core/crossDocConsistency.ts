import type { ProductFactSheet } from '../types';

export interface CrossDocIssue {
  severity: 'warning' | 'error';
  field: string;
  message: string;
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Comparison-normalize: makes "5,01 ¥" and "5.01" equal (decimal comma → dot,
// strip currency/quotes/whitespace) so formatting-only differences are not
// reported as a canonical-vs-document mismatch.
function normalizeForCompare(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/(\d)[,](\d)/g, '$1.$2')
    .replace(/[¥₽руб.\s«»"'()]/g, '')
    .trim();
}

function collectDocValues(fieldLabel: string, docs: Array<{ name: string; content: string }>): string[] {
  const escaped = fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*[:—-]\\s*([^\\n]+)`, 'gi');
  const values: string[] = [];
  for (const doc of docs) {
    for (const match of doc.content.matchAll(regex)) {
      const value = String(match[1] ?? '').trim();
      if (value) values.push(value);
    }
  }
  return values;
}

export function validateCrossDocumentConsistency(input: {
  docs: Array<{ name: string; content: string }>;
  factSheet?: ProductFactSheet | null;
}): CrossDocIssue[] {
  const issues: CrossDocIssue[] = [];
  const docs = input.docs ?? [];

  const allText = docs.map((doc) => doc.content).join('\n');
  if (/объ[её]мный вес/i.test(allText) && !/упаковк/i.test(allText)) {
    issues.push({
      severity: 'error',
      field: 'volumetric_weight',
      message: 'Объёмный вес нельзя показывать без явного указания размеров упаковки.',
    });
  }

  if (/\b125\s*[×x*]\s*92\s*[×x*]\s*82\b/i.test(allText) && /объ[её]мный вес/i.test(allText) && !/упаковк/i.test(allText)) {
    issues.push({
      severity: 'error',
      field: 'shipping_dimensions_basis',
      message: 'Похоже, расчёт логистики опирается на размеры товара, а не упаковки.',
    });
  }

  if (/(?:вес\s*:\s*не указан|вес\s+не\s+указан)/i.test(allText) && /\d+[,.]?\d*\s*кг/i.test(allText)) {
    issues.push({
      severity: 'warning',
      field: 'weight',
      message: 'В документах одновременно встречаются «вес не указан» и числовой вес.',
    });
  }

  for (const fact of input.factSheet?.facts ?? []) {
    if (fact.status === 'unknown' || fact.status === 'supplier_pending' || !fact.label) continue;
    const docValues = collectDocValues(fact.label, docs);
    const normalizedExpected = normalizeForCompare(fact.normalizedValue ?? fact.value);
    if (!normalizedExpected || docValues.length === 0) continue;
    const hasMismatch = docValues.some((value) => {
      const normalized = normalizeForCompare(value);
      return normalized && normalized !== normalizedExpected && !normalized.includes(normalizedExpected) && !normalizedExpected.includes(normalized);
    });
    if (hasMismatch) {
      issues.push({
        severity: 'warning',
        field: fact.key,
        message: `Поле «${fact.label}» расходится между canonical facts и документами.`,
      });
    }
  }

  return issues;
}
