import type { EconomicsResult, WbFilteredResult, RiskFlags, Verdict, MarketScore } from '../types';
import { calcMarketScore } from './marketScore';

export function buildVerdict(
  economics: EconomicsResult,
  wbFiltered: WbFilteredResult | null,
  riskFlags: RiskFlags
): { score: MarketScore; verdict: Verdict } {
  const score = calcMarketScore(wbFiltered, economics, riskFlags);

  let signal: 'green' | 'yellow' | 'red' | 'white';
  if (score.total === null) {
    signal = 'white';
  } else if (score.total >= 65 && !hasCriticalRisks(riskFlags)) {
    signal = 'green';
  } else if (score.total >= 40) {
    signal = 'yellow';
  } else {
    signal = 'red';
  }

  const verdict: Verdict = {
    signal: signal === 'white' ? 'yellow' : signal,
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
