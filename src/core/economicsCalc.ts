import type { EconomicsInput, EconomicsResult } from '../types';

const LOGISTICS_PER_KG = 400;
const WB_COMMISSION = 0.20;
const WB_LOGISTICS = 100;
const FALLBACK_YUAN_TO_RUB = 11.8;

let cachedRate: { value: number; fetchedAt: number } | null = null;
const CACHE_TTL = 3_600_000; // 1 час

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
  const { priceYuan, weightKg, wbAvgPrice } = input;
  const yuanToRub = await fetchYuanRate();

  const purchaseRub = priceYuan * yuanToRub;
  const logisticsRub = Math.max(weightKg * LOGISTICS_PER_KG, 100);
  const costRub = Math.round(purchaseRub + logisticsRub);

  const avgSaleRub = wbAvgPrice
    ? Math.round(wbAvgPrice)
    : Math.round(costRub * 3);

  const wbFee = Math.round(avgSaleRub * WB_COMMISSION);
  const grossProfitRub = avgSaleRub - costRub - wbFee - WB_LOGISTICS;

  return {
    yuanToRub,
    costRub,
    avgSaleRub,
    grossProfitRub,
    disclaimer:
      '⚠️ Расчёт предварительный. Курс юаня, ставки карго и комиссии WB меняются. Уточняйте перед заказом.',
  };
}
