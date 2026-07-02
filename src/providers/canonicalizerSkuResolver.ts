import type { RawProductForCanonicalizer } from './productCanonicalizer';

export interface CanonicalizerSkuResolutionResult {
  promptSegment: string;
  selectedSkuLabel: string | null;
  skuOptions: string[];
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildCanonicalizerSkuResolutionInput(
  raw: RawProductForCanonicalizer,
): CanonicalizerSkuResolutionResult {
  const skuOptions = (raw.normalizedSkuTable ?? raw.skus ?? [])
    .slice(0, 12)
    .map((item: any) => normalizeText(item.label ?? item.name))
    .filter(Boolean);

  const selectedSkuLabel = normalizeText(raw.selectedSkuName) || null;

  return {
    promptSegment: [
      'SKU RESOLUTION INPUT:',
      selectedSkuLabel ? `- Selected SKU: ${selectedSkuLabel}` : '- Selected SKU: not provided',
      ...skuOptions.map((item) => `- Option: ${item}`),
    ].join('\n'),
    selectedSkuLabel,
    skuOptions,
  };
}
