import type { EconomicsResult, WbFilteredResult, RiskFlags, Verdict, ProductVerdict } from '../types';

export function buildVerdict(
  economics: EconomicsResult,
  wbFiltered: WbFilteredResult | null,
  riskFlags: RiskFlags
): Verdict {
  const reasons: string[] = [];

  const hasCriticalRisks = countCriticalRisks(riskFlags) >= 3;
  const grossPositive = economics.grossProfitRub > 0;
  const wbReliable = wbFiltered?.quality === 'reliable';
  const wbLimited = wbFiltered?.quality === 'limited';
  const knownWeight = !riskFlags.weightMissing;
  const knownPrice = economics.costRub > 0;
  const enoughCards = (wbFiltered?.relevantCount ?? 0) >= 20;
  const noCriticalRisks =
    !riskFlags.hasBrand &&
    !riskFlags.isElectrical &&
    !riskFlags.isChildren &&
    !riskFlags.isCosmetic &&
    !riskFlags.isFood &&
    !riskFlags.isMedical;

  // ─── high_risk ──────────────────────────────────────────────────────────────
  const isHighRisk =
    !grossPositive ||
    (wbFiltered?.quality === 'unavailable' && !knownWeight) ||
    hasCriticalRisks ||
    (wbFiltered && wbFiltered.quality !== 'unavailable' && wbFiltered.medianPrice > 0 && economics.costRub > wbFiltered.medianPrice);

  if (isHighRisk) {
    if (!grossPositive) reasons.push('Расчётная валовая разница отрицательная');
    if (hasCriticalRisks) reasons.push('Обнаружено несколько серьёзных рисков');
    if (wbFiltered?.quality === 'unavailable') reasons.push('Нет данных о рынке WB');
    if (wbFiltered && wbFiltered.medianPrice > 0 && economics.costRub > wbFiltered.medianPrice) {
      reasons.push('Себестоимость выше медианной цены WB');
    }
    return { signal: 'red', verdict: 'high_risk', label: '🔴 Высокий риск для тестовой закупки', reasons };
  }

  // ─── test_candidate ─────────────────────────────────────────────────────────
  const isTestCandidate =
    wbReliable &&
    knownPrice &&
    knownWeight &&
    enoughCards &&
    grossPositive &&
    noCriticalRisks;

  if (isTestCandidate) {
    reasons.push('Данные WB достоверны');
    reasons.push('Цена и вес известны');
    reasons.push('Валовая разница положительная');
    return { signal: 'green', verdict: 'test_candidate', label: '🟢 Предварительно подходит для тестовой закупки', reasons };
  }

  // ─── manual_check ───────────────────────────────────────────────────────────
  if (!wbReliable) reasons.push('Данные WB требуют ручной проверки');
  if (riskFlags.hasBrand) reasons.push(`Обнаружен бренд: ${riskFlags.brand}`);
  if (riskFlags.supplierOrdersLow) reasons.push('Мало заказов у поставщика');
  if (riskFlags.weightMissing) reasons.push('Вес товара неизвестен');
  if (riskFlags.isElectrical) reasons.push('Электротовар — нужны документы');
  if (riskFlags.isChildren) reasons.push('Детский товар — нужны сертификаты');
  if (riskFlags.isCosmetic) reasons.push('Косметика — нужны сертификаты');
  if (riskFlags.isFood) reasons.push('Пищевой товар — нужны разрешения');
  if (riskFlags.isMedical) reasons.push('Медицинский товар — нужны документы');
  if (riskFlags.sizeGridRelevant) reasons.push('Размерная сетка может отличаться');

  return { signal: 'yellow', verdict: 'manual_check', label: '🟡 Требуется ручная проверка перед закупкой', reasons };
}

function countCriticalRisks(flags: RiskFlags): number {
  let count = 0;
  if (flags.hasBrand) count++;
  if (flags.isElectrical) count++;
  if (flags.isChildren) count++;
  if (flags.isCosmetic) count++;
  if (flags.isFood) count++;
  if (flags.isMedical) count++;
  if (flags.supplierOrdersLow) count++;
  if (flags.weightMissing) count++;
  if (flags.marketDataUnreliable) count++;
  return count;
}
