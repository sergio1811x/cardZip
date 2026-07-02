import { describe, it, expect } from 'vitest';
import {
  validateProcurementResult,
  type ProcurementQualityInput,
} from './validateProcurementResult';

// A well-formed multi-line document body used across several cases.
const GOOD_DOC_BODY = Array.from(
  { length: 40 },
  (_, i) => `Строка ${i + 1}: реальное содержимое секции документа.`,
).join('\n');

function baseInput(
  overrides: Partial<ProcurementQualityInput> = {},
): ProcurementQualityInput {
  return {
    files: [],
    productDetailsText: 'Товар: реальные данные\nЦена: 98 ¥',
    mainReportText: 'Отчёт с нормальным содержимым.',
    seoDraftMd: 'Название: нормальное\nОписание: нормальное',
    ...overrides,
  };
}

describe('formatting_not_collapsed', () => {
  it('does NOT flag a real multi-line document', () => {
    const input = baseInput({
      files: [{ name: '02_ТЗ_байеру.md', content: GOOD_DOC_BODY }],
    });
    const res = validateProcurementResult(input);
    expect(
      res.errors.some((e) => e.includes('collapsed onto <= 2 lines')),
    ).toBe(false);
  });

  it('DOES flag the same document collapsed onto one line', () => {
    const collapsed = GOOD_DOC_BODY.split('\n').join(' ');
    const input = baseInput({
      files: [{ name: '02_ТЗ_байеру.md', content: collapsed }],
    });
    const res = validateProcurementResult(input);
    expect(res.passed).toBe(false);
    expect(
      res.errors.some((e) => e.includes('collapsed onto <= 2 lines')),
    ).toBe(true);
  });
});

describe('no_placeholders', () => {
  it('catches placeholder "для товара товар"', () => {
    const res = validateProcurementResult(
      baseInput({ mainReportText: 'Отчёт для товара «товар» готов' }),
    );
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('placeholder'))).toBe(true);
  });

  it('catches "Цена: Цена"', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'Цена: Цена 98 ¥' }),
    );
    expect(res.errors.some((e) => /Цена: Цена/.test(e))).toBe(true);
  });

  it('catches "SKU: SKU"', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'SKU: SKU корейский' }),
    );
    expect(res.errors.some((e) => /SKU: SKU/.test(e))).toBe(true);
  });

  it('catches "Материал: Материал"', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'Материал: Материал силикон' }),
    );
    expect(res.errors.some((e) => /Материал: Материал/.test(e))).toBe(true);
  });

  it('catches raw Chinese material in UI', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'Материал: 硅胶面板' }),
    );
    expect(res.errors.some((e) => e.includes('raw Chinese material'))).toBe(
      true,
    );
  });

  it('catches SEO service phrases', () => {
    const res = validateProcurementResult(
      baseInput({
        seoDraftMd: 'черновик карточки товара на основе закупочных данных',
      }),
    );
    expect(res.errors.some((e) => e.includes('SEO service phrase'))).toBe(true);
  });
});

describe('fake_security_camera', () => {
  const seoWithRealClaim =
    'Название: камера\nОписание: запись видео и ночное видение, Wi-Fi подключение';
  const seoAsDummy =
    'Название: муляж камеры\n' +
    'Описание: имитация камеры видеонаблюдения, не ведёт запись.\n' +
    'Нельзя указывать: запись видео, ночное видение, Wi-Fi — без подтверждения.';

  it('flags a real-camera capability asserted as fact', () => {
    const res = validateProcurementResult(
      baseInput({
        productKind: 'fake_security_camera',
        seoDraftMd: seoWithRealClaim,
      }),
    );
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('fake_security_camera'))).toBe(
      true,
    );
  });

  it('passes a муляж/имитация description with a forbidden-claims qualifier', () => {
    const res = validateProcurementResult(
      baseInput({
        productKind: 'fake_security_camera',
        seoDraftMd: seoAsDummy,
      }),
    );
    expect(res.errors.some((e) => e.includes('fake_security_camera'))).toBe(
      false,
    );
  });
});

describe('markdown_table_integrity', () => {
  const seoWithTable = [
    '# SEO',
    '',
    '| Характеристика | Значение |',
    '| --- | --- |',
    '| Материал | силикон |',
    '| Цвет | чёрный |',
  ].join('\n');

  it('passes a SEO md with a proper separator row', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [
          {
            name: '05_SEO_черновик.md',
            content: seoWithTable + '\n' + GOOD_DOC_BODY,
          },
        ],
      }),
    );
    expect(res.errors.some((e) => e.includes('markdown table'))).toBe(false);
  });

  it('fails a SEO md with the table collapsed onto a single line', () => {
    // Collapse the table rows (drop the separator row so it reads as one
    // pipe-bearing line with no `| --- |` marker), padded to exceed the
    // length threshold so the markdown-table rule is what fires.
    const collapsed =
      '# SEO ' +
      '| Характеристика | Значение | Материал | силикон | Цвет | чёрный | ' +
      GOOD_DOC_BODY.split('\n').join(' ');
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: collapsed }],
      }),
    );
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => e.includes('markdown table'))).toBe(true);
  });
});

describe('min_line_counts', () => {
  it('flags an under-length instruction file', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '00_Инструкция.txt', content: 'строка 1\nстрока 2' }],
      }),
    );
    expect(res.errors.some((e) => e.includes('too few lines'))).toBe(true);
  });
});
