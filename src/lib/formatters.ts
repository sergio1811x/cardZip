// ─── Centralized UI formatters ──────────────────────────────────────────────
// All user-facing number/price/weight output MUST go through these.
// Never show 0 ¥, 0 кг, NaN, undefined, null, Infinity, or raw floats to users.

type NumericInput = number | null | undefined;

function isPositiveFinite(value: NumericInput): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function formatCnyPrice(value: NumericInput): string {
  if (!isPositiveFinite(value)) return '—';
  return `${Math.round(value)} ¥`;
}

export function formatCnyRange(min: NumericInput, max: NumericInput): string {
  if (!isPositiveFinite(min)) return '—';

  if (!isPositiveFinite(max)) return formatCnyPrice(min);

  const a = Math.round(Math.min(min, max));
  const b = Math.round(Math.max(min, max));
  if (a <= 0) return '—';
  if (a === b) return `${a} ¥`;
  return `${a}–${b} ¥`;
}

export function formatRubPrice(value: NumericInput): string {
  if (!isPositiveFinite(value)) return '—';
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

export function formatWeightKg(value: NumericInput): string {
  if (!isPositiveFinite(value)) return '—';
  return `${value.toFixed(2)} кг`;
}

export function formatPercent(value: NumericInput): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

export function formatCount(value: NumericInput): string {
  if (!isPositiveFinite(value)) return '—';
  return Math.round(value).toLocaleString('ru-RU');
}

export function safeDisplay(value: unknown, fallback = '—'): string {
  if (value == null || value === '' || value === 0) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value === 0) return fallback;
    return String(value);
  }

  const s = String(value).trim();
  if (!s) return fallback;
  if (/^(undefined|null|nan|infinity|-infinity)$/i.test(s)) return fallback;
  return s;
}
