import type {
  EconomicsInput, EconomicsResult, EconomicsBreakdown,
  BudgetScenarios, BudgetScenario, MaxPurchasePrice,
  UserTariffs, PlatformMode,
} from '../types';

// ─── Smart Defaults ──────────────────────────────────────────────────────────

const USD_TO_RUB = 95;

const DEFAULTS = {
  cargoPerKgUsd: 4.0,
  fulfillmentRub: 80,
  bankMarkupPercent: 3,
  wbCommissionPercent: 20,
  wbLogisticsRub: 100,
  taxPercent: 7,
  targetMarginPercent: 35,
  drrPercent: 15,
};

const CATEGORY_CARGO: Record<string, number> = {
  light: 4.0,
  dense: 3.5,
  heavy: 5.0,
};

const LIGHT_CATEGORIES = /одежд|cloth|текстил|textile|пластик|plastic|игрушк|toy|сумк|bag|обувь|shoe|шапк|hat/i;
const DENSE_CATEGORIES = /электрон|electron|бижутер|jewelr|часы|watch|аксессуар|accessor|телефон|phone|наушник|earphone/i;

function getSmartCargoRate(categoryHint?: string): number {
  if (!categoryHint) return DEFAULTS.cargoPerKgUsd;
  if (LIGHT_CATEGORIES.test(categoryHint)) return CATEGORY_CARGO.light;
  if (DENSE_CATEGORIES.test(categoryHint)) return CATEGORY_CARGO.dense;
  return DEFAULTS.cargoPerKgUsd;
}

// ─── FX Rate ─────────────────────────────────────────────────────────────────

const FALLBACK_YUAN_TO_RUB = 11.8;
let cachedRate: { value: number; fetchedAt: number } | null = null;
const CACHE_TTL = 3_600_000;

async function fetchYuanRate(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL) {
    return cachedRate.value;
  }
  try {
    const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { Valute?: { CNY?: { Value?: number; Nominal?: number } } };
    const cny = data.Valute?.CNY;
    if (cny?.Value && cny?.Nominal) {
      const rate = cny.Value / cny.Nominal;
      if (isFinite(rate) && rate > 0) {
        cachedRate = { value: rate, fetchedAt: Date.now() };
        return rate;
      }
    }
  } catch (e) {
    console.warn('[fx] Не удалось получить курс ЦБ:', e instanceof Error ? e.message : e);
  }
  return cachedRate?.value ?? FALLBACK_YUAN_TO_RUB;
}

export async function getYuanRate(): Promise<number> {
  return fetchYuanRate();
}

// ─── Platform Mode ───────────────────────────────────────────────────────────

function getPlatformMode(platform: string): PlatformMode {
  if (platform === '1688') return 'full';
  if (platform === 'taobao') return 'sample_only';
  return 'reference_only';
}

// ─── Main Calculation ────────────────────────────────────────────────────────

export async function calcEconomics(input: EconomicsInput): Promise<EconomicsResult> {
  const { platform, priceYuan, weightKg, wbMedianPrice, wbAvgPrice, categoryHint, tariffs } = input;
  const yuanToRub = await fetchYuanRate();
  const weightMissing = !weightKg || weightKg <= 0;
  const isCustom = !!(tariffs?.cargoPerKgUsd || tariffs?.fulfillmentRub || tariffs?.taxPercent || tariffs?.targetMarginPercent || tariffs?.drrPercent);
  const platformMode = getPlatformMode(platform);

  const cargoPerKgUsd = tariffs?.cargoPerKgUsd ?? getSmartCargoRate(categoryHint);
  const fulfillmentRub = tariffs?.fulfillmentRub ?? DEFAULTS.fulfillmentRub;
  const taxPercent = tariffs?.taxPercent ?? DEFAULTS.taxPercent;
  const targetMargin = tariffs?.targetMarginPercent ?? DEFAULTS.targetMarginPercent;
  const drrPercent = tariffs?.drrPercent ?? DEFAULTS.drrPercent;

  // Себестоимость (одинаково для всех платформ)
  const purchaseRub = Math.round(priceYuan * yuanToRub);
  const bankMarkupRub = Math.round(purchaseRub * DEFAULTS.bankMarkupPercent / 100);
  const cargoRub = weightMissing ? 0 : Math.round(weightKg * cargoPerKgUsd * USD_TO_RUB);
  const internalLogisticsRub = weightMissing ? 0 : fulfillmentRub;
  const costRub = purchaseRub + bankMarkupRub + cargoRub + internalLogisticsRub;

  // Для Taobao/Tmall — только себестоимость, без расчёта прибыли
  if (platformMode !== 'full') {
    const breakdown: EconomicsBreakdown = {
      purchaseYuan: priceYuan, purchaseRub, bankMarkupRub, cargoRub,
      internalLogisticsRub, wbCommissionRub: 0, wbLogisticsRub: 0, taxRub: 0, drrRub: 0, drrPercent: 0,
    };
    const disclaimer = platformMode === 'sample_only'
      ? 'Taobao — розничная площадка. Рассчитана ориентировочная стоимость образца. Для партии найдите аналог на 1688.'
      : 'Tmall — брендовый маркетплейс. Проверьте права на товарный знак. Для OEM-закупки найдите аналог на 1688.';

    return {
      yuanToRub, platformMode, breakdown, costRub,
      avgSaleRub: 0, grossProfitRub: 0, grossMarginPercent: 0, roiPercent: 0,
      weightMissing, isCustomTariffs: isCustom, isSyntheticPrice: true,
      disclaimer,
    };
  }

  // 1688: полный расчёт
  const salePrice = wbMedianPrice ?? wbAvgPrice;
  const isSyntheticPrice = !salePrice;
  const avgSaleRub = salePrice
    ? Math.round(salePrice)
    : Math.round(costRub / (1 - DEFAULTS.wbCommissionPercent / 100 - targetMargin / 100));

  const wbCommissionRub = Math.round(avgSaleRub * DEFAULTS.wbCommissionPercent / 100);
  const taxRub = Math.round(avgSaleRub * taxPercent / 100);
  const drrRub = Math.round(avgSaleRub * drrPercent / 100);
  const grossProfitRub = avgSaleRub - costRub - wbCommissionRub - DEFAULTS.wbLogisticsRub - taxRub - drrRub;
  const grossMarginPercent = avgSaleRub > 0 ? Math.round((grossProfitRub / avgSaleRub) * 100) : 0;
  const roiPercent = costRub > 0 ? Math.round((grossProfitRub / costRub) * 100) : 0;

  const breakdown: EconomicsBreakdown = {
    purchaseYuan: priceYuan, purchaseRub, bankMarkupRub, cargoRub,
    internalLogisticsRub, wbCommissionRub, wbLogisticsRub: DEFAULTS.wbLogisticsRub,
    taxRub, drrRub, drrPercent,
  };

  let disclaimer = 'Расчёт ориентировочный. Комиссии, логистика, реклама, возвраты и фактическая цена продажи могут отличаться.';
  if (isSyntheticPrice) {
    disclaimer = `Цена продажи рассчитана при целевой марже ${targetMargin}%, а не взята с рынка. ` + disclaimer;
  }
  // Не дублируем про вес — это показывается в messageBuilder
  if (isCustom) {
    disclaimer = 'Расчёт по вашим тарифам. ' + disclaimer;
  }

  return {
    yuanToRub, platformMode, breakdown, costRub, avgSaleRub,
    grossProfitRub, grossMarginPercent, roiPercent,
    weightMissing, isCustomTariffs: isCustom, isSyntheticPrice,
    disclaimer,
  };
}

// ─── Max Purchase Price ──────────────────────────────────────────────────────

export function calcMaxPurchasePrice(
  wbMedianPrice: number,
  weightKg: number,
  yuanToRub: number,
  tariffs?: UserTariffs,
  currentPriceYuan?: number
): MaxPurchasePrice | null {
  if (!wbMedianPrice || wbMedianPrice <= 0) return null;

  const targetMargin = tariffs?.targetMarginPercent ?? DEFAULTS.targetMarginPercent;
  const drrPercent = tariffs?.drrPercent ?? DEFAULTS.drrPercent;
  const taxPercent = tariffs?.taxPercent ?? DEFAULTS.taxPercent;
  const cargoPerKgUsd = tariffs?.cargoPerKgUsd ?? DEFAULTS.cargoPerKgUsd;
  const fulfillmentRub = tariffs?.fulfillmentRub ?? DEFAULTS.fulfillmentRub;

  const targetProfitRub = wbMedianPrice * targetMargin / 100;
  const wbCommRub = wbMedianPrice * DEFAULTS.wbCommissionPercent / 100;
  const drrRub = wbMedianPrice * drrPercent / 100;
  const taxRub = wbMedianPrice * taxPercent / 100;

  const allowedCostRub = wbMedianPrice - wbCommRub - DEFAULTS.wbLogisticsRub - drrRub - taxRub - targetProfitRub;
  const cargoRub = weightKg > 0 ? weightKg * cargoPerKgUsd * USD_TO_RUB : 0;
  const maxProductRub = allowedCostRub - cargoRub - fulfillmentRub;
  const maxYuan = maxProductRub / (yuanToRub * (1 + DEFAULTS.bankMarkupPercent / 100));

  return {
    maxYuan: Math.round(maxYuan * 100) / 100,
    currentYuan: currentPriceYuan ?? 0,
    allowed: (currentPriceYuan ?? 0) <= maxYuan,
    targetMarginPercent: targetMargin,
  };
}

// ─── Budget Scenarios ────────────────────────────────────────────────────────

export function calcBudgetScenarios(
  unitCostRub: number,
  weightMissing: boolean,
  moq?: number
): BudgetScenarios {
  const reservePercent = 15;

  function scenario(label: string, qty: number): BudgetScenario {
    const goodsCostRub = unitCostRub * qty;
    const reserveRub = Math.round(goodsCostRub * reservePercent / 100);
    return { label, quantity: qty, goodsCostRub, reserveRub, totalRub: goodsCostRub + reserveRub };
  }

  const testQty = moq && moq > 20 ? moq : 20;
  const batchQty = moq && moq > 50 ? moq : 50;

  return {
    sample: scenario('Образец', 1),
    test: scenario('Тест', testQty),
    firstBatch: scenario('Первая партия', batchQty),
    weightMissing,
  };
}
