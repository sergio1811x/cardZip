import type { EconomicsInput, EconomicsResult, TestPurchaseResult } from '../types';

const LOGISTICS_PER_KG = 400;
const WB_COMMISSION = 0.20;
const WB_LOGISTICS = 100;
const FALLBACK_YUAN_TO_RUB = 11.8;
const DEFAULT_TEST_QUANTITY = 20;
const DEFAULT_RESERVE_PERCENT = 15;

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
    console.warn('[fx] ЦБ вернул невалидные данные CNY:', JSON.stringify(cny));
  } catch (e) {
    console.warn('[fx] Не удалось получить курс ЦБ:', e instanceof Error ? e.message : e);
  }

  return cachedRate?.value ?? FALLBACK_YUAN_TO_RUB;
}

export async function getYuanRate(): Promise<number> {
  return fetchYuanRate();
}

export async function calcEconomics(input: EconomicsInput): Promise<EconomicsResult> {
  const { priceYuan, weightKg, wbMedianPrice, wbAvgPrice } = input;
  const yuanToRub = await fetchYuanRate();
  const weightMissing = !weightKg || weightKg <= 0;

  const purchaseRub = priceYuan * yuanToRub;
  const logisticsRub = weightMissing ? 0 : Math.max(weightKg * LOGISTICS_PER_KG, 100);
  const costRub = Math.round(purchaseRub + logisticsRub);

  const salePrice = wbMedianPrice ?? wbAvgPrice;
  const avgSaleRub = salePrice ? Math.round(salePrice) : Math.round(costRub * 3);

  const wbFee = Math.round(avgSaleRub * WB_COMMISSION);
  const grossProfitRub = avgSaleRub - costRub - wbFee - WB_LOGISTICS;
  const grossMarginPercent = avgSaleRub > 0
    ? Math.round((grossProfitRub / avgSaleRub) * 100)
    : 0;

  let disclaimer = '⚠️ Расчёт предварительный. Курс юаня, ставки карго и комиссии WB меняются. Уточняйте перед заказом.';
  if (weightMissing) {
    disclaimer = '⚠️ Вес не указан — логистика не учтена. Реальная себестоимость будет выше. ' + disclaimer;
  }

  return {
    yuanToRub,
    costRub,
    avgSaleRub,
    grossProfitRub,
    grossMarginPercent,
    weightMissing,
    disclaimer,
  };
}

export function calcTestPurchase(
  unitCostRub: number,
  weightMissing: boolean,
  quantity: number = DEFAULT_TEST_QUANTITY
): TestPurchaseResult | null {
  if (weightMissing) return null;

  const goodsAndCargoRub = unitCostRub * quantity;
  const reserveRub = Math.round(goodsAndCargoRub * DEFAULT_RESERVE_PERCENT / 100);
  const testBudgetRub = goodsAndCargoRub + reserveRub;

  return {
    quantity,
    goodsAndCargoRub,
    reservePercent: DEFAULT_RESERVE_PERCENT,
    reserveRub,
    testBudgetRub,
  };
}
