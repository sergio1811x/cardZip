import type { Platform, EconomicsResult, WbFilteredResult, RiskFlags, PlatformConclusion } from '../types';

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

  const hasStrongWb = wbFiltered && (wbFiltered.quality === 'reliable' || wbFiltered.quality === 'limited');
  const hasWeakWb = wbFiltered && wbFiltered.quality === 'unreliable' && wbFiltered.relevantCount > 0;
  const noWb = !wbFiltered || wbFiltered.quality === 'unavailable' || wbFiltered.relevantCount === 0;
  const marginPositive = economics.grossProfitRub > 0;
  const wm = economics.weightMissing;

  // Вес отсутствует — нельзя давать финальный вывод
  if (wm) {
    disclaimers.push('Вес неизвестен — экономика неполная.');
    return {
      platform,
      icon: '🟡',
      headline: 'Экономика неполная. Уточните вес у поставщика перед решением.',
      disclaimers,
    };
  }

  if (hasStrongWb && marginPositive && !economics.isSyntheticPrice) {
    if (riskFlags.hasBrand) disclaimers.push('Обнаружен бренд — проверьте права перед закупкой.');
    return {
      platform,
      icon: '🟢',
      headline: 'Ориентировочная маржа положительная. Товар можно протестировать.',
      disclaimers,
    };
  }

  if (hasStrongWb && !marginPositive && !economics.isSyntheticPrice) {
    return {
      platform,
      icon: '🔴',
      headline: 'Маржа отрицательная при текущей закупочной цене. Проверьте оптовые цены.',
      disclaimers,
    };
  }

  if (hasWeakWb && !economics.isSyntheticPrice) {
    disclaimers.push('Выборка WB ограничена — проверьте выдачу вручную.');
    if (marginPositive) {
      return {
        platform,
        icon: '🟡',
        headline: 'Маржа предварительно положительная, но выборка мала. Проверьте рынок вручную.',
        disclaimers,
      };
    }
    return {
      platform,
      icon: '🔴',
      headline: 'Маржа отрицательная при ограниченной выборке. Проверьте оптовые цены.',
      disclaimers,
    };
  }

  if (noWb) {
    disclaimers.push('Оцените спрос на WB вручную перед закупкой.');
    return {
      platform,
      icon: '⚪️',
      headline: 'Аналоги на WB не найдены. Оцените рынок вручную перед закупкой.',
      disclaimers,
    };
  }

  // WB есть но цена синтетическая
  return {
    platform,
    icon: '🟡',
    headline: 'Себестоимость рассчитана. Проверьте реальную цену продажи на WB.',
    disclaimers,
  };
}
