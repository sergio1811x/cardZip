// ─── Centralized UI formatters ──────────────────────────────────────────────
// All user-facing number/price/weight output MUST go through these.
// Never show 0 ¥, 0 кг, NaN, undefined, null, or raw floats to users.

export function formatCnyPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return `${Math.round(value)} ¥`;
}

export function formatCnyRange(min: number | undefined, max: number | undefined): string {
  if (!min || min <= 0) return '—';
  if (!max || max <= 0 || min === max) return `${Math.round(min)} ¥`;
  return `${Math.round(min)}–${Math.round(max)} ¥`;
}

export function formatRubPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

export function formatWeightKg(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return `${value.toFixed(2)} кг`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  return value.toLocaleString('ru-RU');
}

export function safeDisplay(value: unknown, fallback = '—'): string {
  if (value == null || value === '' || value === 0) return fallback;
  const s = String(value);
  if (s === 'undefined' || s === 'null' || s === 'NaN') return fallback;
  return s;
}
