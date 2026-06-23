import type { EconomicsInput, EconomicsResult, EconomicsBreakdown, TestPurchaseResult, UserTariffs } from '../types';

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
};

const CATEGORY_CARGO: Record<string, number> = {
  light: 4.0,   // одежда, пластик, объёмные
  dense: 3.5,   // бижутерия, электроника, мелкое плотное
  heavy: 5.0,   // инструменты, металл
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
        console.log(`[fx] Курс ЦБ: 1 CNY = ${rate.toFixed(2)} RUB`);
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

// ─── Main Calculation ────────────────────────────────────────────────────────

export async function calcEconomics(input: EconomicsInput): Promise<EconomicsResult> {
  const { priceYuan, weightKg, wbMedianPrice, wbAvgPrice, categoryHint, tariffs } = input;
  const yuanToRub = await fetchYuanRate();
  const weightMissing = !weightKg || weightKg <= 0;
  const isCustom = !!(tariffs?.cargoPerKgUsd || tariffs?.fulfillmentRub || tariffs?.taxPercent || tariffs?.targetMarginPercent);

  const cargoPerKgUsd = tariffs?.cargoPerKgUsd ?? getSmartCargoRate(categoryHint);
  const fulfillmentRub = tariffs?.fulfillmentRub ?? DEFAULTS.fulfillmentRub;
  const taxPercent = tariffs?.taxPercent ?? DEFAULTS.taxPercent;
  const targetMargin = tariffs?.targetMarginPercent ?? DEFAULTS.targetMarginPercent;

  // Декомпозиция
  const purchaseRub = Math.round(priceYuan * yuanToRub);
  const bankMarkupRub = Math.round(purchaseRub * DEFAULTS.bankMarkupPercent / 100);
  const cargoRub = weightMissing ? 0 : Math.round(weightKg * cargoPerKgUsd * USD_TO_RUB);
  const internalLogisticsRub = weightMissing ? 0 : fulfillmentRub;

  const costRub = purchaseRub + bankMarkupRub + cargoRub + internalLogisticsRub;

  // Цена продажи
  const salePrice = wbMedianPrice ?? wbAvgPrice;
  const avgSaleRub = salePrice
    ? Math.round(salePrice)
    : Math.round(costRub / (1 - DEFAULTS.wbCommissionPercent / 100 - targetMargin / 100));

  const wbCommissionRub = Math.round(avgSaleRub * DEFAULTS.wbCommissionPercent / 100);
  const taxRub = Math.round(avgSaleRub * taxPercent / 100);
  const grossProfitRub = avgSaleRub - costRub - wbCommissionRub - DEFAULTS.wbLogisticsRub - taxRub;
  const grossMarginPercent = avgSaleRub > 0 ? Math.round((grossProfitRub / avgSaleRub) * 100) : 0;
  const roiPercent = costRub > 0 ? Math.round((grossProfitRub / costRub) * 100) : 0;

  // Рекомендуемая цена при целевой марже
  const denominator = 1 - DEFAULTS.wbCommissionPercent / 100 - taxPercent / 100 - targetMargin / 100;
  const recommendedPriceRub = denominator > 0
    ? Math.round((costRub + DEFAULTS.wbLogisticsRub) / denominator)
    : 0;

  const breakdown: EconomicsBreakdown = {
    purchaseYuan: priceYuan,
    purchaseRub,
    bankMarkupRub,
    cargoRub,
    internalLogisticsRub,
    wbCommissionRub,
    wbLogisticsRub: DEFAULTS.wbLogisticsRub,
    taxRub,
  };

  let disclaimer = isCustom
    ? 'Расчёт по вашим тарифам.'
    : `Карго $${cargoPerKgUsd}/кг, фулфилмент ${fulfillmentRub}₽, налог ${taxPercent}%. Настройте под себя → ⚙️`;
  if (weightMissing) {
    disclaimer = '⚠️ Вес не указан — карго не учтено. ' + disclaimer;
  }

  return {
    yuanToRub,
    breakdown,
    costRub,
    avgSaleRub,
    grossProfitRub,
    grossMarginPercent,
    roiPercent,
    recommendedPriceRub,
    weightMissing,
    isCustomTariffs: isCustom,
    disclaimer,
  };
}

// ─── Test Purchase ───────────────────────────────────────────────────────────

const DEFAULT_TEST_QUANTITY = 20;
const DEFAULT_RESERVE_PERCENT = 15;

export function calcTestPurchase(
  unitCostRub: number,
  weightMissing: boolean,
  moq?: number,
  quantity: number = DEFAULT_TEST_QUANTITY
): TestPurchaseResult | null {
  if (weightMissing) return null;

  const actualQty = moq && moq > quantity ? moq : quantity;
  const goodsAndCargoRub = unitCostRub * actualQty;
  const reserveRub = Math.round(goodsAndCargoRub * DEFAULT_RESERVE_PERCENT / 100);
  const testBudgetRub = goodsAndCargoRub + reserveRub;

  return {
    quantity: actualQty,
    goodsAndCargoRub,
    reservePercent: DEFAULT_RESERVE_PERCENT,
    reserveRub,
    testBudgetRub,
  };
}
