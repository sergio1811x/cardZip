import type { Platform, EconomicsResult, WbFilteredResult, RiskFlags, PlatformConclusion } from '../types';

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getDirectAnalogCount(wbFiltered: WbFilteredResult | null): number {
  const raw = wbFiltered as any;
  return getNumber(raw?.directAnalogsCount) ?? getNumber(raw?.directCount) ?? getNumber(raw?.relevantCount) ?? 0;
}

function isMarketConfirmed(wbFiltered: WbFilteredResult | null): boolean {
  if (!wbFiltered) return false;
  const raw = wbFiltered as any;
  if (raw.marketConfirmed === true || raw.canUseForEconomics === true) return true;
  return wbFiltered.quality === 'reliable' && getDirectAnalogCount(wbFiltered) >= 3;
}

export function buildConclusion(
  platform: Platform,
  economics: EconomicsResult,
  wbFiltered: WbFilteredResult | null,
  riskFlags: RiskFlags
): PlatformConclusion {
  const disclaimers: string[] = [];

  // ─── Taobao ────────────────────────────────────────────────────────────────
  if (platform === 'taobao') {
    disclaimers.push('Цена на странице не подтверждает стоимость партии.');
    disclaimers.push('Для закупки запросите цену на 20/50/100 шт. или найдите OEM-аналог на 1688.');
    return {
      platform,
      icon: '🛒',
      headline: 'Taobao — розничная витрина. Закажите образец, затем найдите фабрику на 1688.',
      disclaimers,
    };
  }

  // ─── Tmall ─────────────────────────────────────────────────────────────────
  if (platform === 'tmall') {
    disclaimers.push('Проверьте права на бренд, товарный знак и использование фото.');
    disclaimers.push('Для закупки найдите OEM-аналог на 1688.');
    return {
      platform,
      icon: '🏷',
      headline: 'Tmall — брендовый маркетплейс. Проверьте права на товарный знак. Ищите OEM на 1688.',
      disclaimers,
    };
  }

  // ─── 1688 ──────────────────────────────────────────────────────────────────
  disclaimers.push('Подтвердите цену выбранного SKU, вес с упаковкой и цену партии у поставщика.');
  if (economics.isEstimatedPrice) {
    disclaimers.push('Расчёт предварительный — цена взята из ориентировочных данных поставщика.');
  }

  const directAnalogCount = getDirectAnalogCount(wbFiltered);
  const marketConfirmed = isMarketConfirmed(wbFiltered);
  const hasLimitedWb = Boolean(wbFiltered && wbFiltered.quality === 'limited' && directAnalogCount > 0);
  const hasWeakWb = Boolean(wbFiltered && wbFiltered.quality === 'unreliable' && directAnalogCount > 0);
  const noWb = !wbFiltered || wbFiltered.quality === 'unavailable' || directAnalogCount === 0;
  const marginPositive = economics.grossProfitRub > 0;
  const wm = economics.weightMissing;
  const canShowRoi = (economics as any).canShowRoi !== false;

  if (wm && economics.categoryDefaultWeightKg) {
    disclaimers.push(`Вес оценочный (~${Math.round(economics.categoryDefaultWeightKg * 1000)}г). Уточните реальный вес у поставщика.`);
  } else if (wm) {
    return {
      platform,
      icon: '🟡',
      headline: 'Для расчёта экономики нужен вес. Уточните вес товара с упаковкой у поставщика.',
      disclaimers,
    };
  }

  if (riskFlags.hasBrand) {
    disclaimers.push('Обнаружен бренд или брендовый риск — проверьте права перед закупкой.');
  }

  if (marketConfirmed && !economics.isSyntheticPrice && canShowRoi) {
    disclaimers.push(`Рыночная цена опирается на подтверждённые прямые аналоги WB: ${directAnalogCount} шт.`);

    if (marginPositive) {
      return {
        platform,
        icon: '🟢',
        headline: 'Есть подтверждённые аналоги на WB, базовый сценарий положительный. Следующий шаг — образец и подтверждение SKU/веса/партии.',
        disclaimers,
      };
    }
    return {
      platform,
      icon: '🔴',
      headline: 'Аналоги на WB подтверждены, но маржа отрицательная по базовому сценарию. Проверьте оптовые цены и логистику.',
      disclaimers,
    };
  }

  if (hasLimitedWb || hasWeakWb) {
    disclaimers.push('Найденные WB-карточки нельзя использовать как подтверждённую рыночную цену.');
    disclaimers.push('ROI и маржу не стоит считать до подтверждения прямых локальных аналогов.');
    return {
      platform,
      icon: '🟡',
      headline: 'Есть похожие товары на WB, но рынок не подтверждён. Используйте результат как гипотезу, не как экономику.',
      disclaimers,
    };
  }

  if (noWb) {
    disclaimers.push('Рыночная цена не подтверждена. ROI и маржу считать нельзя.');
    return {
      platform,
      icon: '⚪️',
      headline: 'Прямые аналоги на WB не подтверждены. Перед закупкой нужно проверить рынок вручную или расширить поиск.',
      disclaimers,
    };
  }

  // WB есть, но цена синтетическая или ROI запрещён validator/snapshot-логикой.
  disclaimers.push('Себестоимость можно использовать только как внутренний ориентир. Цена продажи на WB не подтверждена.');
  return {
    platform,
    icon: '🟡',
    headline: 'Себестоимость рассчитана, но рыночная цена WB не подтверждена. ROI не показывать.',
    disclaimers,
  };
}
