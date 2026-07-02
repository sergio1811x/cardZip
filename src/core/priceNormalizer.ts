/**
 * Strict price normalizer.
 *
 * Guarantees a well-formed price object where the numeric fields and the
 * human display text can NEVER diverge into broken strings like
 * "8нужно уточнить", "Цена: Цена", NaN/undefined/null.
 *
 * A number is NEVER concatenated with fallback text. Either a price is known
 * and reliable (→ "98 ¥ ≈ 1 156 ₽"), a plausible range is known
 * (→ "80–98 ¥", not reliable), or the price is unknown (→ "нужно уточнить").
 */

const YUAN_TO_RUB = 11.8;

// Guardrails against garbage inputs: 0, negatives, NaN, or absurd values.
const MIN_PLAUSIBLE_YUAN = 0.1;
const MAX_PLAUSIBLE_YUAN = 1_000_000;

export type NormalizedPriceInput = {
  selectedPriceYuan?: number | null;
  minPriceYuan?: number | null;
  maxPriceYuan?: number | null;
  priceYuan?: number | null;
};

export type NormalizedPrice = {
  selectedPriceYuan: number | null;
  minPriceYuan: number | null;
  maxPriceYuan: number | null;
  displayPriceText: string;
  priceReliable: boolean;
  warnings: string[];
};

function sanitize(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_PLAUSIBLE_YUAN || n > MAX_PLAUSIBLE_YUAN) return null;
  return Math.round(n * 100) / 100;
}

function yuanText(v: number): string {
  return `${String(v).replace(".", ",")} ¥`;
}

function rubText(v: number): string {
  return `${Math.round(v).toLocaleString("ru-RU")} ₽`;
}

export function yuanToRub(yuan: number): number {
  return Math.round(yuan * YUAN_TO_RUB);
}

export function normalizePrice(raw: NormalizedPriceInput): NormalizedPrice {
  const selected = sanitize(raw.selectedPriceYuan ?? raw.priceYuan);
  const min = sanitize(raw.minPriceYuan);
  const max = sanitize(raw.maxPriceYuan);
  const warnings: string[] = [];

  // 1. Reliable: a single selected/known price.
  if (selected != null) {
    return {
      selectedPriceYuan: selected,
      minPriceYuan: min ?? selected,
      maxPriceYuan: max ?? selected,
      displayPriceText: `${yuanText(selected)} ≈ ${rubText(yuanToRub(selected))}`,
      priceReliable: true,
      warnings,
    };
  }

  // 2. Range known but no single selected SKU price → not reliable.
  if (min != null && max != null && max !== min) {
    warnings.push("цена выбранного SKU требует подтверждения");
    return {
      selectedPriceYuan: null,
      minPriceYuan: min,
      maxPriceYuan: max,
      displayPriceText: `${String(min).replace(".", ",")}–${String(max).replace(".", ",")} ¥`,
      priceReliable: false,
      warnings,
    };
  }

  // 2b. Single boundary value (min==max or only one present) but not a
  // confirmed selected SKU → show the value, still not reliable.
  const single = min ?? max;
  if (single != null) {
    warnings.push("цена выбранного SKU требует подтверждения");
    return {
      selectedPriceYuan: null,
      minPriceYuan: single,
      maxPriceYuan: single,
      displayPriceText: yuanText(single),
      priceReliable: false,
      warnings,
    };
  }

  // 3. Unknown.
  warnings.push("нет цены в данных");
  return {
    selectedPriceYuan: null,
    minPriceYuan: null,
    maxPriceYuan: null,
    displayPriceText: "нужно уточнить",
    priceReliable: false,
    warnings,
  };
}
