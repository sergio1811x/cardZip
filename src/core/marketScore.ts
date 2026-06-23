import type { WbFilteredResult, EconomicsResult, RiskFlags, MarketScore, ProductVerdict } from '../types';

// Спрос (30%): proxy по суммарным отзывам в нише
function scoreDemand(wbFiltered: WbFilteredResult | null): number {
  if (!wbFiltered || wbFiltered.quality === 'unavailable') return 0;
  const fb = wbFiltered.totalFeedbacks;
  if (fb >= 5000) return 100;
  if (fb >= 2000) return 80;
  if (fb >= 500) return 60;
  if (fb >= 100) return 40;
  if (fb >= 20) return 20;
  return 10;
}

// Конкуренция (30%): чем меньше карточек и отзывов на карточку — тем лучше для входа
function scoreCompetition(wbFiltered: WbFilteredResult | null): number {
  if (!wbFiltered || wbFiltered.quality === 'unavailable') return 0;
  const n = wbFiltered.relevantCount;
  const avgFb = n > 0 ? wbFiltered.totalFeedbacks / n : 0;

  let cardScore: number;
  if (n <= 10) cardScore = 100;
  else if (n <= 20) cardScore = 80;
  else if (n <= 40) cardScore = 60;
  else if (n <= 80) cardScore = 40;
  else cardScore = 20;

  // Если средние отзывы на карточку > 500 — ниша забита сильными игроками
  let fbScore: number;
  if (avgFb <= 50) fbScore = 100;
  else if (avgFb <= 200) fbScore = 70;
  else if (avgFb <= 500) fbScore = 40;
  else fbScore = 20;

  return Math.round(cardScore * 0.5 + fbScore * 0.5);
}

// Маржа (30%): на основе grossMarginPercent
function scoreMargin(economics: EconomicsResult): number {
  const m = economics.grossMarginPercent;
  if (m >= 50) return 100;
  if (m >= 35) return 80;
  if (m >= 20) return 60;
  if (m >= 10) return 40;
  if (m >= 0) return 20;
  return 0;
}

// Надёжность (10%): качество данных + поставщик
function scoreReliability(wbFiltered: WbFilteredResult | null, riskFlags: RiskFlags): number {
  let s = 50;
  if (wbFiltered?.quality === 'reliable') s += 30;
  else if (wbFiltered?.quality === 'limited') s += 10;
  else s -= 20;

  if (!riskFlags.weightMissing) s += 10;
  if (!riskFlags.supplierOrdersLow) s += 10;
  if (!riskFlags.hasBrand) s += 5;
  if (riskFlags.marketDataUnreliable) s -= 15;

  return Math.max(0, Math.min(100, s));
}

function verdictFromScore(total: number, riskFlags: RiskFlags): { verdict: ProductVerdict; signal: 'green' | 'yellow' | 'red'; label: string } {
  const hasCritical = riskFlags.hasBrand || riskFlags.isElectrical || riskFlags.isChildren ||
    riskFlags.isCosmetic || riskFlags.isFood || riskFlags.isMedical;

  if (total >= 65 && !hasCritical) {
    return { verdict: 'test_candidate', signal: 'green', label: '🟢 GO — подходит для тестовой закупки' };
  }
  if (total >= 40) {
    return { verdict: 'manual_check', signal: 'yellow', label: '🟡 TEST — требуется ручная проверка' };
  }
  return { verdict: 'high_risk', signal: 'red', label: '🔴 NO GO — высокий риск' };
}

export function calcMarketScore(
  wbFiltered: WbFilteredResult | null,
  economics: EconomicsResult,
  riskFlags: RiskFlags
): MarketScore {
  const demandScore = scoreDemand(wbFiltered);
  const competitionScore = scoreCompetition(wbFiltered);
  const marginScore = scoreMargin(economics);
  const reliabilityScore = scoreReliability(wbFiltered, riskFlags);

  const total = Math.round(
    demandScore * 0.30 +
    competitionScore * 0.30 +
    marginScore * 0.30 +
    reliabilityScore * 0.10
  );

  const { verdict, label } = verdictFromScore(total, riskFlags);

  const reasons: string[] = [];
  if (demandScore >= 60) reasons.push(`Спрос: высокий (${demandScore}/100)`);
  else if (demandScore >= 30) reasons.push(`Спрос: средний (${demandScore}/100)`);
  else reasons.push(`Спрос: низкий (${demandScore}/100)`);

  if (competitionScore >= 60) reasons.push(`Конкуренция: слабая (${competitionScore}/100)`);
  else if (competitionScore >= 30) reasons.push(`Конкуренция: средняя (${competitionScore}/100)`);
  else reasons.push(`Конкуренция: сильная (${competitionScore}/100)`);

  if (marginScore >= 60) reasons.push(`Маржа: высокая (${marginScore}/100)`);
  else if (marginScore >= 30) reasons.push(`Маржа: средняя (${marginScore}/100)`);
  else reasons.push(`Маржа: низкая (${marginScore}/100)`);

  return { total, demandScore, competitionScore, marginScore, reliabilityScore, verdict, label, reasons };
}
