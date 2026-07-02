import type { RawProductForCanonicalizer } from './productCanonicalizer';

export interface CanonicalizerPolicyInputResult {
  promptSegment: string;
  highRiskClaims: string[];
}

const HIGH_RISK_TOKENS = [
  'сертифицированный',
  'антибактериальный',
  'гипоаллергенный',
  'лечебный',
  'безопасный для детей',
  'waterproof',
  'ip67',
];

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildCanonicalizerPolicyInput(
  raw: RawProductForCanonicalizer,
): CanonicalizerPolicyInputResult {
  const joined = [
    normalizeText(raw.titleCn),
    normalizeText(raw.titleRu),
    normalizeText(raw.titleEn),
    ...(raw.attributes ?? []).map((item) => `${normalizeText(item.name)} ${normalizeText(item.value)}`),
  ].join(' ').toLowerCase();

  const highRiskClaims = HIGH_RISK_TOKENS.filter((token) => joined.includes(token.toLowerCase()));

  return {
    promptSegment: [
      'POLICY INPUT:',
      highRiskClaims.length
        ? `- High-risk claims found: ${highRiskClaims.join(', ')}`
        : '- High-risk claims found: none',
    ].join('\n'),
    highRiskClaims,
  };
}
