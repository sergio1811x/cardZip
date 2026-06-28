import { describe, it, expect } from 'vitest';
import { formatCnyPrice, formatRubPrice, formatWeightKg, formatPercent, formatCnyRange, safeDisplay } from './formatters';

describe('formatCnyPrice', () => {
  it('returns — for 0', () => expect(formatCnyPrice(0)).toBe('—'));
  it('returns — for null', () => expect(formatCnyPrice(null)).toBe('—'));
  it('returns — for undefined', () => expect(formatCnyPrice(undefined)).toBe('—'));
  it('returns — for negative', () => expect(formatCnyPrice(-5)).toBe('—'));
  it('returns — for NaN', () => expect(formatCnyPrice(NaN)).toBe('—'));
  it('returns — for Infinity', () => expect(formatCnyPrice(Infinity)).toBe('—'));
  it('formats 26', () => expect(formatCnyPrice(26)).toBe('26 ¥'));
  it('rounds 26.7', () => expect(formatCnyPrice(26.7)).toBe('27 ¥'));
});

describe('formatRubPrice', () => {
  it('returns — for 0', () => expect(formatRubPrice(0)).toBe('—'));
  it('returns — for null', () => expect(formatRubPrice(null)).toBe('—'));
  it('formats 1395', () => expect(formatRubPrice(1395)).toMatch(/1\s?395 ₽/));
});

describe('formatWeightKg', () => {
  it('returns — for 0', () => expect(formatWeightKg(0)).toBe('—'));
  it('returns — for null', () => expect(formatWeightKg(null)).toBe('—'));
  it('rounds long float', () => expect(formatWeightKg(0.3775411164787976)).toBe('0.38 кг'));
  it('formats 1.5', () => expect(formatWeightKg(1.5)).toBe('1.50 кг'));
});

describe('formatPercent', () => {
  it('returns — for null', () => expect(formatPercent(null)).toBe('—'));
  it('returns — for NaN', () => expect(formatPercent(NaN)).toBe('—'));
  it('formats 45.678', () => expect(formatPercent(45.678)).toBe('45.7%'));
});

describe('formatCnyRange', () => {
  it('returns — for no min', () => expect(formatCnyRange(undefined, undefined)).toBe('—'));
  it('formats single', () => expect(formatCnyRange(26, 26)).toBe('26 ¥'));
  it('formats range', () => expect(formatCnyRange(26, 28)).toBe('26–28 ¥'));
  it('normalizes reversed range', () => expect(formatCnyRange(28, 26)).toBe('26–28 ¥'));
  it('ignores invalid max', () => expect(formatCnyRange(26, NaN)).toBe('26 ¥'));
});

describe('safeDisplay', () => {
  it('returns — for null', () => expect(safeDisplay(null)).toBe('—'));
  it('returns — for 0', () => expect(safeDisplay(0)).toBe('—'));
  it('returns — for empty string', () => expect(safeDisplay('')).toBe('—'));
  it('returns — for padded null marker', () => expect(safeDisplay(' null ')).toBe('—'));
  it('returns value for real string', () => expect(safeDisplay('hello')).toBe('hello'));
});
