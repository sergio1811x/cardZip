import type { WbFilteredResult, EconomicsResult, RiskFlags, MarketScore, ProductVerdict } from '../types';

function hasWbData(wbFiltered: WbFilteredResult | null): boolean {
  return !!wbFiltered && wbFiltered.quality !== 'unavailable' && wbFiltered.relevantCount > 0;
}

function scoreDemand(wbFiltered: WbFilteredResult | null): number | null {
  if (!hasWbData(wbFiltered)) return null;
  const fb = wbFiltered!.totalFeedbacks;
  if (fb >= 5000) return 100;
  if (fb >= 2000) return 80;
  if (fb >= 500) return 60;
  if (fb >= 100) return 40;
  if (fb >= 20) return 20;
  return 10;
}

function scoreCompetition(wbFiltered: WbFilteredResult | null): number | null {
  if (!hasWbData(wbFiltered)) return null;
  const n = wbFiltered!.relevantCount;
  const avgFb = n > 0 ? wbFiltered!.totalFeedbacks / n : 0;

  let cardScore: number;
  if (n <= 10) cardScore = 100;
  else if (n <= 20) cardScore = 80;
  else if (n <= 40) cardScore = 60;
  else if (n <= 80) cardScore = 40;
  else cardScore = 20;

  let fbScore: number;
  if (avgFb <= 50) fbScore = 100;
  else if (avgFb <= 200) fbScore = 70;
  else if (avgFb <= 500) fbScore = 40;
  else fbScore = 20;

  return Math.round(cardScore * 0.5 + fbScore * 0.5);
}

function scoreMargin(economics: EconomicsResult, hasPriceFromWb: boolean): number | null {
  if (!hasPriceFromWb) return null;
  const m = economics.grossMarginPercent;
  if (m >= 50) return 100;
  if (m >= 35) return 80;
  if (m >= 20) return 60;
  if (m >= 10) return 40;
  if (m >= 0) return 20;
  return 0;
}

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

export function calcMarketScore(
  wbFiltered: WbFilteredResult | null,
  economics: EconomicsResult,
  riskFlags: RiskFlags
): MarketScore {
  const wbAvailable = hasWbData(wbFiltered);
  const demandScore = scoreDemand(wbFiltered);
  const competitionScore = scoreCompetition(wbFiltered);
  const marginScore = scoreMargin(economics, wbAvailable);
  const reliabilityScore = scoreReliability(wbFiltered, riskFlags);

  // Если нет WB данных — score не вычисляется
  if (demandScore === null || competitionScore === null || marginScore === null) {
    return {
      total: null,
      demandScore,
      competitionScore,
      marginScore,
      reliabilityScore,
      verdict: 'no_data',
      label: '⚪️ НОВИНКА ИЛИ НЕТ ДАННЫХ — на WB не найдено точных аналогов',
      reasons: ['Скоринг заблокирован: нет данных с Wildberries для оценки рынка'],
    };
  }

  const total = Math.round(
    demandScore * 0.30 +
    competitionScore * 0.30 +
    marginScore * 0.30 +
    reliabilityScore * 0.10
  );

  const hasCritical = riskFlags.hasBrand || riskFlags.isElectrical || riskFlags.isChildren ||
    riskFlags.isCosmetic || riskFlags.isFood || riskFlags.isMedical;

  let verdict: ProductVerdict;
  let label: string;
  if (total >= 65 && !hasCritical) {
    verdict = 'test_candidate';
    label = '🟢 GO — подходит для тестовой закупки';
  } else if (total >= 40) {
    verdict = 'manual_check';
    label = '🟡 TEST — требуется ручная проверка';
  } else {
    verdict = 'high_risk';
    label = '🔴 NO GO — высокий риск';
  }

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
