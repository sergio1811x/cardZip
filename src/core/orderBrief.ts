import type { RawProduct1688, AiContentResult, EconomicsResult, RiskFlags, BudgetScenarios, PlatformConclusion } from '../types';
import { buildBuyerBrief, validateGeneratedText, buildDecisionContext } from './decisionLayer';

export function formatOrderBrief(
  product: RawProduct1688,
  content: AiContentResult,
  _economics: EconomicsResult,
  _riskFlags: RiskFlags,
  sourceUrl: string,
  _budgets?: BudgetScenarios | null,
  _conclusion?: PlatformConclusion | null
): string {
  const merged = { ...(product as any), seoContent: content };
  const x = buildDecisionContext(merged);
  const raw = buildBuyerBrief(merged, sourceUrl);
  const validation = validateGeneratedText({
    productIntelligence: x.intelligence,
    generatedText: raw,
    reportType: 'buyerBrief',
    categoryType: x.categoryType,
    marketDecision: x.market,
    weightDecision: x.weight,
  });
  return validation.fixedText || raw;
}
