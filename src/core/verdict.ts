import type { EconomicsResult, WbFilteredResult, RiskFlags, Verdict, MarketScore } from '../types';
import { calcMarketScore } from './marketScore';

export function buildVerdict(
  economics: EconomicsResult,
  wbFiltered: WbFilteredResult | null,
  riskFlags: RiskFlags
): { score: MarketScore; verdict: Verdict } {
  const score = calcMarketScore(wbFiltered, economics, riskFlags);

  const verdict: Verdict = {
    signal: score.total >= 65 && !hasCriticalRisks(riskFlags) ? 'green'
      : score.total >= 40 ? 'yellow' : 'red',
    verdict: score.verdict,
    label: score.label,
    reasons: score.reasons,
  };

  return { score, verdict };
}

function hasCriticalRisks(flags: RiskFlags): boolean {
  return flags.hasBrand || flags.isElectrical || flags.isChildren ||
    flags.isCosmetic || flags.isFood || flags.isMedical;
}
