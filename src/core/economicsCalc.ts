import type { EconomicsInput, EconomicsResult, EconomicsBreakdown, TestPurchaseResult } from '../types';

const LOGISTICS_PER_KG = 400;
const BANK_MARKUP_PERCENT = 3;
const WB_COMMISSION_PERCENT = 20;
const WB_LOGISTICS = 100;
const INTERNAL_LOGISTICS = 50;
const TAX_PERCENT = 7;
const TARGET_MARGIN_PERCENT = 35;
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

  // Декомпозиция расходов
  const purchaseRub = Math.round(priceYuan * yuanToRub);
  const bankMarkupRub = Math.round(purchaseRub * BANK_MARKUP_PERCENT / 100);
  const cargoRub = weightMissing ? 0 : Math.max(Math.round(weightKg * LOGISTICS_PER_KG), 100);
  const internalLogisticsRub = weightMissing ? 0 : INTERNAL_LOGISTICS;

  const costRub = purchaseRub + bankMarkupRub + cargoRub + internalLogisticsRub;

  // Цена продажи: медиана WB или рекомендация от себестоимости
  const salePrice = wbMedianPrice ?? wbAvgPrice;
  const avgSaleRub = salePrice ? Math.round(salePrice) : Math.round(costRub / (1 - WB_COMMISSION_PERCENT / 100 - TARGET_MARGIN_PERCENT / 100));

  const wbCommissionRub = Math.round(avgSaleRub * WB_COMMISSION_PERCENT / 100);
  const taxRub = Math.round(avgSaleRub * TAX_PERCENT / 100);
  const grossProfitRub = avgSaleRub - costRub - wbCommissionRub - WB_LOGISTICS - taxRub;
  const grossMarginPercent = avgSaleRub > 0
    ? Math.round((grossProfitRub / avgSaleRub) * 100)
    : 0;
  const roiPercent = costRub > 0
    ? Math.round((grossProfitRub / costRub) * 100)
    : 0;

  // Рекомендуемая цена при целевой марже
  const recommendedPriceRub = Math.round(costRub / (1 - WB_COMMISSION_PERCENT / 100 - TARGET_MARGIN_PERCENT / 100 - TAX_PERCENT / 100 - WB_LOGISTICS / Math.max(avgSaleRub, 1)));

  const breakdown: EconomicsBreakdown = {
    purchaseYuan: priceYuan,
    purchaseRub,
    bankMarkupRub,
    cargoRub,
    internalLogisticsRub,
    wbCommissionRub,
    wbLogisticsRub: WB_LOGISTICS,
    taxRub,
  };

  let disclaimer = 'Расчёт предварительный. Уточняйте актуальные ставки перед заказом.';
  if (weightMissing) {
    disclaimer = 'Вес не указан — логистика не учтена. Реальная себестоимость будет выше. ' + disclaimer;
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
