import { describe, it, expect } from 'vitest';
import {
  validateProcurementResult,
  type ProcurementQualityInput,
} from './validateProcurementResult';

// Well-formed body to satisfy line-count minimums where needed.
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
    seoDraftMd: 'Название: нормальное\nОписание: нормальный текст описания товара.',
    ...overrides,
  };
}

describe('text-quality rules (yoga shorts regressions)', () => {
  it('flags composition percentage asserted as fact', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: 'Состав: 90% нейлон, 10% спандекс',
      }),
    );
    expect(res.passed).toBe(false);
    expect(
      res.errors.some((e) => e.includes('composition percentage asserted')),
    ).toBe(true);
  });

  it('does NOT flag composition with a "— подтвердить" qualifier', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: 'Состав: 90% нейлон, 10% спандекс — подтвердить',
      }),
    );
    expect(
      res.errors.some((e) => e.includes('composition percentage asserted')),
    ).toBe(false);
  });

  it('does NOT flag a numberless composition ask', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: 'Подтвердите состав ткани.',
      }),
    );
    expect(
      res.errors.some((e) => e.includes('composition percentage asserted')),
    ).toBe(false);
  });

  it('warns on nominative after "для" ("для йога, фитнес, бег")', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'Шорты для йога, фитнес, бег' }),
    );
    expect(res.warnings.some((w) => w.includes("nominative after 'для'"))).toBe(
      true,
    );
  });

  it('does NOT warn on correct genitive ("для йоги, фитнеса, бега")', () => {
    const res = validateProcurementResult(
      baseInput({ productDetailsText: 'Шорты для йоги, фитнеса, бега' }),
    );
    expect(res.warnings.some((w) => w.includes("nominative after 'для'"))).toBe(
      false,
    );
  });

  it('warns on duplicate size-chart question intent', () => {
    const content = [
      '1. Уточните размерную сетку изделия.',
      '2. Какой материал верха?',
      '3. Пришлите размерную сетку по всем размерам.',
      ...Array.from({ length: 25 }, (_, i) => `${i + 4}. Вопрос ${i + 4}.`),
    ].join('\n');
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '01_Вопросы_поставщику.txt', content }],
      }),
    );
    expect(
      res.warnings.some((w) => w.includes('duplicate question intent')),
    ).toBe(true);
  });

  it('does NOT warn on a single size-chart question', () => {
    const content = [
      '1. Уточните размерную сетку изделия.',
      '2. Какой материал верха?',
      ...Array.from({ length: 25 }, (_, i) => `${i + 3}. Вопрос ${i + 3}.`),
    ].join('\n');
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '01_Вопросы_поставщику.txt', content }],
      }),
    );
    expect(
      res.warnings.some((w) => w.includes('duplicate question intent')),
    ).toBe(false);
  });

  it('warns on bare-fragment risk lines mixed with full sentences', () => {
    const content = [
      '# Красные флаги',
      '- нет состава и',
      '- плохие швы или',
      '- Проверьте усадку ткани после стирки в тёплой воде.',
      '- Убедитесь, что размерная сетка соответствует таблице.',
    ].join('\n');
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '04_Чеклист_образца.md', content }],
      }),
    );
    expect(
      res.warnings.some((w) => w.includes('unpolished bare-fragment line')),
    ).toBe(true);
  });

  it('does NOT warn when all risk lines are full sentences', () => {
    const content = [
      '# Красные флаги',
      '- Отсутствует информация о составе ткани.',
      '- Швы выглядят некачественно на фото.',
      '- Проверьте усадку ткани после стирки.',
    ].join('\n');
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '04_Чеклист_образца.md', content }],
      }),
    );
    expect(
      res.warnings.some((w) => w.includes('unpolished bare-fragment line')),
    ).toBe(false);
  });

  it('warns on SEO description starting with a bare noun', () => {
    const res = validateProcurementResult(
      baseInput({
        seoDraftMd: 'Название: Шорты\nОписание: шорты.',
      }),
    );
    expect(
      res.warnings.some((w) =>
        w.includes('SEO description starts with a bare noun'),
      ),
    ).toBe(true);
  });

  it('does NOT warn on a proper SEO description', () => {
    const res = validateProcurementResult(
      baseInput({
        seoDraftMd:
          'Название: Шорты\nОписание: спортивные шорты для активного отдыха.',
      }),
    );
    expect(
      res.warnings.some((w) =>
        w.includes('SEO description starts with a bare noun'),
      ),
    ).toBe(false);
  });

  it('flags every defect from a BAD yoga-shorts fixture', () => {
    const questions = [
      '1. Пришлите размерную сетку.',
      '2. Уточните размерную сетку по всем размерам.',
      ...Array.from({ length: 25 }, (_, i) => `${i + 3}. Вопрос ${i + 3}.`),
    ].join('\n');
    const checklist = [
      '# Красные флаги',
      '- нет состава и',
      '- плохие швы или',
      '- проверить усадку от',
      '- Проверьте плотность ткани и качество швов на образце.',
      ...Array.from({ length: 30 }, (_, i) => `Строка ${i + 1}: содержимое.`),
    ].join('\n');
    const res = validateProcurementResult(
      baseInput({
        productKind: 'clothing',
        productDetailsText:
          'Товар: спортивные шорты для йога, фитнес, бег\nСостав: 90% нейлон, 10% спандекс',
        seoDraftMd: 'Название: Шорты\nОписание: шорты.',
        files: [
          { name: '01_Вопросы_поставщику.txt', content: questions },
          { name: '04_Чеклист_образца.md', content: checklist },
        ],
      }),
    );
    expect(
      res.errors.some((e) => e.includes('composition percentage asserted')),
    ).toBe(true);
    expect(res.warnings.some((w) => w.includes("nominative after 'для'"))).toBe(
      true,
    );
    expect(
      res.warnings.some((w) => w.includes('duplicate question intent')),
    ).toBe(true);
    expect(
      res.warnings.some((w) => w.includes('unpolished bare-fragment line')),
    ).toBe(true);
    expect(
      res.warnings.some((w) =>
        w.includes('SEO description starts with a bare noun'),
      ),
    ).toBe(true);
  });

  it('produces ZERO errors on a CLEAN yoga-shorts fixture', () => {
    const questions = [
      '1. Пришлите размерную сетку по всем размерам.',
      '2. Какой материал верха и подкладки?',
      ...Array.from({ length: 25 }, (_, i) => `${i + 3}. Вопрос ${i + 3}.`),
    ].join('\n');
    const checklist = [
      '# Красные флаги',
      '- Отсутствует подтверждённая информация о составе ткани.',
      '- Проверьте качество швов и плотность материала на образце.',
      '- Убедитесь в отсутствии сильной усадки после стирки.',
      ...Array.from({ length: 35 }, (_, i) => `Строка ${i + 1}: содержимое.`),
    ].join('\n');
    const res = validateProcurementResult(
      baseInput({
        productKind: 'clothing',
        productDetailsText:
          'Товар: спортивные шорты для йоги, фитнеса, бега\n' +
          'Состав: 90% нейлон, 10% спандекс — подтвердить',
        seoDraftMd:
          'Название: Спортивные шорты\n' +
          'Описание: лёгкие спортивные шорты для тренировок и отдыха.',
        files: [
          { name: '01_Вопросы_поставщику.txt', content: questions },
          { name: '04_Чеклист_образца.md', content: checklist },
          { name: '02_ТЗ_байеру.md', content: GOOD_DOC_BODY },
        ],
      }),
    );
    expect(res.errors).toEqual([]);
  });
});
