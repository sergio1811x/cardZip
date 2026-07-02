import { describe, it, expect } from 'vitest';
import {
  validateProcurementResult,
  type ProcurementQualityInput,
} from './validateProcurementResult';

function baseInput(
  overrides: Partial<ProcurementQualityInput> = {},
): ProcurementQualityInput {
  return {
    files: [],
    productDetailsText: 'Товар: реальные данные',
    mainReportText: 'Отчёт с нормальным содержимым.',
    seoDraftMd: 'Название: нормальное\nОписание: нормальное',
    ...overrides,
  };
}

describe('report_rendering_regressions', () => {
  it('flags a glued digit before "нужно уточнить" (after ≈)', () => {
    const res = validateProcurementResult(
      baseInput({ mainReportText: 'Цена: 72 ¥ ≈ 85нужно уточнить' }),
    );
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('glued price fallback'))).toBe(true);
  });

  it('flags raw Chinese in a labeled user-facing field', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: '• Материал: 铜' }),
    );
    expect(res.passed).toBe(false);
    expect(
      res.errors.some(
        (e) =>
          e.includes('raw Chinese in labeled field') ||
          e.includes('raw Chinese material'),
      ),
    ).toBe(true);
  });

  it('flags a raw attribute label (Han in the label itself)', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: '• 外形Размер: 150*140*100' }),
    );
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('raw attribute label'))).toBe(true);
  });

  it('flags a number-soup SKU line', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText:
          'Параметры: 250 / 80 / 20 / 10 / 5 / 100 / 50 / 200 / 300 / 30',
      }),
    );
    expect(res.passed).toBe(false);
    expect(
      res.errors.some((e) => e.includes('number-soup SKU without labels')),
    ).toBe(true);
  });

  it('flags a number-soup "Выбранный SKU" line', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'Выбранный SKU: 68800 80 10 250 5' }),
    );
    expect(res.passed).toBe(false);
    expect(
      res.errors.some((e) => e.includes('number-soup SKU without labels')),
    ).toBe(true);
  });

  it('flags duplicate material (Cyrillic + Han values)', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: '• материал: медь\n• Материал: 铜',
      }),
    );
    expect(res.passed).toBe(false);
    expect(
      res.errors.some(
        (e) =>
          e.includes('duplicate material') || e.includes('raw Chinese'),
      ),
    ).toBe(true);
  });
});

describe('report_rendering_clean_fixture', () => {
  const clean = baseInput({
    productDetailsText: [
      '• Цена: 72 ¥ ≈ 850 ₽',
      '• Выбранный SKU: 26800 мА·ч · 20 Вт · кабель 10 м',
      '• Материал: медь — подтвердить',
      'Название CN: 2025 太阳能照明灯 户外防水',
    ].join('\n'),
    mainReportText: 'Цена: 72 ¥ ≈ 850 ₽\nСтатус: нужны данные поставщика',
    seoDraftMd:
      'Название: уличный светильник\nОписание: нормальное описание товара',
    selectedSkuText: '26800 мА·ч · 20 Вт · кабель 10 м',
  });

  it('passes the clean fixture with no errors', () => {
    const res = validateProcurementResult(clean);
    expect(res.errors).toEqual([]);
    expect(res.passed).toBe(true);
  });

  it('does NOT flag a unit-labeled SKU as number-soup', () => {
    const res = validateProcurementResult(clean);
    expect(res.errors.some((e) => e.includes('number-soup'))).toBe(false);
  });

  it('does NOT flag a "Название CN:" Chinese line as raw Chinese', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: 'Название CN: 2025 太阳能照明灯 户外防水灯',
      }),
    );
    expect(res.errors.some((e) => e.includes('raw Chinese'))).toBe(false);
    expect(res.errors.some((e) => e.includes('raw attribute label'))).toBe(false);
  });

  it('does NOT flag "72 ¥ ≈ 850 ₽" as a glued price fallback', () => {
    const res = validateProcurementResult(
      baseInput({ mainReportText: 'Цена: 72 ¥ ≈ 850 ₽' }),
    );
    expect(res.errors.some((e) => e.includes('glued price fallback'))).toBe(
      false,
    );
  });
});
