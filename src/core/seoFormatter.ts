import type { AiContentResult, RawProduct1688, RiskFlags } from '../types';
import { buildSeoDraft, validateGeneratedText, buildDecisionContext } from './decisionLayer';

export function formatSeoText(
  product: RawProduct1688,
  content: AiContentResult,
  _riskFlags?: RiskFlags
): string {
  const merged = { ...(product as any), seoContent: content };
  const x = buildDecisionContext(merged);
  const raw = buildSeoDraft(merged);
  const validation = validateGeneratedText({
    productIntelligence: x.intelligence,
    generatedText: raw,
    reportType: 'seo',
    categoryType: x.categoryType,
    marketDecision: x.market,
    weightDecision: x.weight,
  });
  return validation.fixedText || raw;
}
