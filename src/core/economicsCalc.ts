import type { EconomicsInput, EconomicsResult } from '../types';

// Константы — вынесены наружу для простой замены без правки логики
const YUAN_TO_RUB = 13.5;     // курс юань→рубль (обновляй вручную раз в неделю)
const LOGISTICS_PER_KG = 400; // ₽/кг: Китай → Россия карго, ~усреднённо
const WB_COMMISSION = 0.20;   // 20% комиссия WB
const WB_LOGISTICS = 100;     // ₽ за отправку одной единицы через WB

export function calcEconomics(input: EconomicsInput): EconomicsResult {
  const { priceYuan, weightKg, wbAvgPrice } = input;

  // Закупочная стоимость + доставка
  const purchaseRub = priceYuan * YUAN_TO_RUB;
  const logisticsRub = Math.max(weightKg * LOGISTICS_PER_KG, 100);
  const costRub = Math.round(purchaseRub + logisticsRub);

  // Средняя цена продажи: берём из WB или оцениваем как x3 от себестоимости
  const avgSaleRub = wbAvgPrice
    ? Math.round(wbAvgPrice)
    : Math.round(costRub * 3);

  // Валовая прибыль = цена продажи − себестоимость − комиссия WB − логистика WB
  const wbFee = Math.round(avgSaleRub * WB_COMMISSION);
  const grossProfitRub = avgSaleRub - costRub - wbFee - WB_LOGISTICS;

  return {
    costRub,
    avgSaleRub,
    grossProfitRub,
    disclaimer:
      '⚠️ Расчёт предварительный. Курс юаня, ставки карго и комиссии WB меняются. Уточняй перед заказом.',
  };
}
