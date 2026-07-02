import type { RawProductForCanonicalizer } from './productCanonicalizer';

export interface CanonicalizerClassificationResult {
  promptSegment: string;
  visualHints: string[];
  textHints: string[];
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildCanonicalizerClassificationInput(
  raw: RawProductForCanonicalizer,
): CanonicalizerClassificationResult {
  const textHints = [
    normalizeText(raw.titleCn),
    normalizeText(raw.titleRu),
    normalizeText(raw.titleEn),
    normalizeText(raw.categoryName),
  ].filter(Boolean);

  const visualHints = (raw.imageUrls ?? [])
    .slice(0, 3)
    .map((item) => normalizeText(item.role || item.note || 'image'))
    .filter(Boolean);

  const skuHints = (raw.normalizedSkuTable ?? raw.skus ?? [])
    .slice(0, 6)
    .map((item: any) => normalizeText(item.label ?? item.name))
    .filter(Boolean);

  return {
    promptSegment: [
      'CLASSIFICATION INPUT:',
      ...textHints.map((item) => `- ${item}`),
      ...skuHints.map((item) => `- SKU: ${item}`),
    ].join('\n'),
    visualHints,
    textHints: [...textHints, ...skuHints],
  };
}
