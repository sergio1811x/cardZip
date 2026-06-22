import type { EconomicsResult, WbSearchResult, Verdict } from '../types';

export function buildVerdict(
  economics: EconomicsResult,
  wbData: WbSearchResult | null,
  sold?: number
): Verdict {
  const reasons: string[] = [];
  let score = 0;

  // Маржинальность
  const margin = economics.avgSaleRub > 0
    ? (economics.grossProfitRub / economics.avgSaleRub) * 100
    : 0;

  if (margin >= 30) {
    reasons.push('Маржа: высокая');
    score += 2;
  } else if (margin >= 15) {
    reasons.push('Маржа: средняя');
    score += 1;
  } else {
    reasons.push('Маржа: низкая');
    score -= 1;
  }

  // Конкуренция
  if (wbData) {
    if (wbData.totalCards < 500) {
      reasons.push('Конкуренция: низкая');
      score += 2;
    } else if (wbData.totalCards < 2000) {
      reasons.push('Конкуренция: средняя');
      score += 1;
    } else {
      reasons.push('Конкуренция: высокая');
      score -= 1;
    }
  }

  // Цена закупки
  if (economics.costRub < 300) {
    reasons.push('Цена закупки: низкая');
    score += 1;
  } else if (economics.costRub < 1000) {
    reasons.push('Цена закупки: средняя');
  } else {
    reasons.push('Цена закупки: высокая');
    score -= 1;
  }

  // Популярность у поставщика
  if (sold && sold > 1000) {
    reasons.push('Спрос у поставщика: высокий');
    score += 1;
  }

  if (score >= 3) {
    return { signal: 'green', label: '🟢 Можно тестировать', reasons };
  } else if (score >= 1) {
    return { signal: 'yellow', label: '🟡 Требует анализа', reasons };
  } else {
    return { signal: 'red', label: '🔴 Не рекомендовано', reasons };
  }
}
