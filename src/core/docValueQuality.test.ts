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

// A long, product-specific SEO doc that satisfies the min-line rule (40 lines)
// so we can assert new rules fire/don't fire without min-line noise.
function padLines(text: string, min = 45): string {
  const lines = text.split('\n');
  while (lines.length < min) lines.push('');
  return lines.join('\n');
}

function padCargo(text: string, min = 30): string {
  const lines = text.split('\n');
  while (lines.length < min) lines.push('');
  return lines.join('\n');
}

describe('doc value quality — SEO', () => {
  const badSeo = padLines(
    [
      '## Название',
      'Кресло надувное для отдыха на природе US вилка',
      '',
      '## Описание',
      'кресло.',
      '',
      '## Буллеты',
      '- Удобное надувное кресло для отдыха',
      '- Компактно складывается',
      '- SKU в карточке: 15 вариантов',
      '- Лёгкий вес для переноски',
      '- Подходит для дома и улицы',
      '',
      '## Характеристики',
      'максимальная нагрузка 12вес не указан',
      '',
      '## Ключевые слова',
      'кресло, кресло, надувное, надувное, отдых',
    ].join('\n'),
  );

  it('flags bare-noun description opener', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: badSeo }],
        seoDraftMd: badSeo,
      }),
    );
    expect(
      res.warnings.some((w) => /bare noun/i.test(w)),
    ).toBe(true);
  });

  it('flags internal advice in selling bullets', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: badSeo }],
        seoDraftMd: badSeo,
      }),
    );
    expect(
      res.warnings.some((w) => /internal advice in selling bullets/.test(w)),
    ).toBe(true);
  });

  it('flags glued spec+fallback "12вес не указан" (ERROR)', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: badSeo }],
        seoDraftMd: badSeo,
      }),
    );
    expect(res.passed).toBe(false);
    expect(res.errors.some((e) => /glued spec\+fallback/.test(e))).toBe(true);
  });

  it('flags duplicated keyword tokens (keyword soup)', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: badSeo }],
        seoDraftMd: badSeo,
      }),
    );
    expect(res.warnings.some((w) => /low-quality keywords/.test(w))).toBe(true);
  });

  it('flags full title repeated verbatim in keywords', () => {
    const seo = padLines(
      [
        '## Название',
        'Кресло надувное для отдыха на природе с сумкой',
        '',
        '## Описание',
        'Надувное кресло для комфортного отдыха на природе. Складывается в компактную сумку.',
        '',
        '## Ключевые слова',
        'Кресло надувное для отдыха на природе с сумкой, кресло, отдых',
      ].join('\n'),
    );
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: seo }],
        seoDraftMd: seo,
      }),
    );
    expect(res.warnings.some((w) => /low-quality keywords/.test(w))).toBe(true);
  });

  const goodSeo = padLines(
    [
      '## Название',
      'Надувное кресло для отдыха на природе с сумкой',
      '',
      '## Описание',
      'Надувное кресло легко наполняется воздухом за несколько секунд без насоса.',
      'Прочный материал выдерживает вес взрослого человека и подходит для дачи и кемпинга.',
      'В комплекте компактная сумка для переноски и хранения.',
      '',
      '## Буллеты',
      '- Наполняется воздухом за секунды без насоса',
      '- Выдерживает вес взрослого человека',
      '- Компактно складывается в сумку',
      '- Подходит для дачи, пляжа и кемпинга',
      '- Прочный водоотталкивающий материал',
      '',
      '## Ключевые слова',
      'надувное кресло, лежак, кемпинг, пляж, отдых, дача',
    ].join('\n'),
  );

  it('good SEO produces zero ERRORS', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '05_SEO_черновик.md', content: goodSeo }],
        seoDraftMd: goodSeo,
      }),
    );
    expect(res.errors).toEqual([]);
    // And none of the new SEO warnings should fire on clean content.
    expect(res.warnings.some((w) => /internal advice in selling bullets/.test(w))).toBe(false);
    expect(res.warnings.some((w) => /low-quality keywords/.test(w))).toBe(false);
    expect(res.warnings.some((w) => /bare noun/i.test(w))).toBe(false);
  });
});

describe('doc value quality — cargo', () => {
  const badCargo = padCargo(
    [
      '# ТЗ карго',
      '',
      '## Товар',
      'Надувное кресло',
      '',
      '## Дополнительно',
      '- специальных ограничений не найдено',
      '',
      '## Текущий статус',
      'Объёмный вес: 188 кг',
    ].join('\n'),
  );

  it('flags generic-only cargo section', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '03_ТЗ_карго.md', content: badCargo }],
      }),
    );
    expect(
      res.warnings.some((w) => /no product-specific considerations/.test(w)),
    ).toBe(true);
  });

  it('flags implausible volumetric weight without caveat', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '03_ТЗ_карго.md', content: badCargo }],
      }),
    );
    expect(
      res.warnings.some((w) => /volumetric weight likely from product/.test(w)),
    ).toBe(true);
  });

  const goodCargo = padCargo(
    [
      '# ТЗ карго',
      '',
      '## Товар',
      'Надувное кресло',
      '',
      '## Дополнительно',
      '- Уточните, не относится ли товар к негабаритным грузам',
      '- Проверьте требования к упаковке хрупкого клапана',
      '',
      '## Текущий статус',
      'Объёмный вес: 188 кг — запросите габариты упаковки, значение может быть от товара, а не коробки',
    ].join('\n'),
  );

  it('good cargo produces zero ERRORS and no new warnings', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '03_ТЗ_карго.md', content: goodCargo }],
      }),
    );
    expect(res.errors).toEqual([]);
    expect(
      res.warnings.some((w) => /no product-specific considerations/.test(w)),
    ).toBe(false);
    expect(
      res.warnings.some((w) => /volumetric weight likely from product/.test(w)),
    ).toBe(false);
  });
});
