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
    productDetailsText: 'Товар: кухонный нож',
    mainReportText: 'Отчёт с нормальным содержимым.',
    seoDraftMd: 'Название: нож кухонный\nОписание: нож для кухни',
    ...overrides,
  };
}

// Pad a file to satisfy min-line rules so unrelated rules do not add noise.
function pad(text: string, min = 40): string {
  const lines = text.split('\n');
  while (lines.length < min) lines.push('');
  return lines.join('\n');
}

describe('knife quality — BAD fixtures flagged', () => {
  it('flags category label injected as product name (кухонный товар)', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: 'Вопрос: уточните материал для товара «кухонный товар»',
      }),
    );
    expect(
      res.errors.some((e) => /category label injected as product name/.test(e)),
    ).toBe(true);
  });

  it('flags quoted category label «кухонный товар»', () => {
    const res = validateProcurementResult(
      baseInput({
        mainReportText: 'Название: «кухонный товар»',
      }),
    );
    expect(
      res.errors.some((e) => /category label injected as product name/.test(e)),
    ).toBe(true);
  });

  it('flags wrong-product CN tokens (接水盘 / meta) in CN questions file', () => {
    const cn = pad(
      [
        '01_Вопросы_поставщику.txt',
        '1. Материал лезвия?',
        '   CN: 接水盘 层架 挂钩',
        '2. Метагаражбадж?',
        '   CN: 该问题中的相关产品信息',
      ].join('\n'),
    );
    const res = validateProcurementResult(
      baseInput({ files: [{ name: '01_Вопросы_поставщику.txt', content: cn }] }),
    );
    expect(
      res.errors.some((e) => /wrong-product or meta CN question/.test(e)),
    ).toBe(true);
  });

  it('flags duplicate CN question (warning)', () => {
    const cn = pad(
      [
        '1. Материал лезвия?',
        '   CN: 刀刃的材质是什么？',
        '2. Материал лезвия ещё раз?',
        '   CN: 刀刃的材质是什么？',
      ].join('\n'),
    );
    const res = validateProcurementResult(
      baseInput({ files: [{ name: '01_Вопросы_поставщику.txt', content: cn }] }),
    );
    expect(res.warnings.some((w) => /duplicate CN question/.test(w))).toBe(true);
  });

  it('flags doubled "неподтверждённое свойство"', () => {
    const res = validateProcurementResult(
      baseInput({
        mainReportText:
          'SKU: острота неподтверждённое свойство и сталь неподтверждённое свойство',
      }),
    );
    expect(
      res.errors.some((e) =>
        /doubled 'неподтверждённое свойство'/.test(e),
      ),
    ).toBe(true);
  });

  it('flags material fragment duplicated (3CR13 …, 3 нержавеющая сталь) (warning)', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: 'Материал: 3CR13 нержавеющая сталь, 3 нержавеющая сталь',
      }),
    );
    expect(
      res.warnings.some((w) => /material fragment duplicated/.test(w)),
    ).toBe(true);
  });
});

describe('knife quality — CLEAN fixture, zero errors', () => {
  const cleanQuestions = pad(
    [
      '01_Вопросы_поставщику.txt',
      '1. Из какой стали изготовлено лезвие?',
      '   CN: 刀刃采用什么钢材制造？',
      '2. Какая твёрдость по Роквеллу?',
      '   CN: 洛氏硬度是多少？',
      '3. Какая длина лезвия и общая длина?',
      '   CN: 刀刃长度和总长度是多少？',
      '4. Материал рукояти?',
      '   CN: 手柄的材质是什么？',
      '5. Какой вес ножа с упаковкой?',
      '   CN: 刀具连包装的重量是多少？',
    ].join('\n'),
  );

  const cleanReport = pad(
    [
      '📦 Нож кухонный шеф',
      'Источник: 1688',
      '📌 Товар',
      '• Материал: 3CR13 нержавеющая сталь — подтвердить',
      '• Выбранный SKU: длина 20 см / чёрная рукоять',
      '• Острота: неподтверждённое свойство — уточнить',
    ].join('\n'),
    20,
  );

  const cleanSeo = pad(
    [
      '## Название',
      'Нож кухонный шеф 20 см',
      '',
      '## Описание',
      'Кухонный нож с лезвием из нержавеющей стали для повседневной готовки.',
    ].join('\n'),
    45,
  );

  it('produces zero errors on a clean knife package', () => {
    const res = validateProcurementResult(
      baseInput({
        productDetailsText: cleanReport,
        mainReportText: cleanReport,
        seoDraftMd: cleanSeo,
        selectedSkuText: 'длина 20 см / чёрная рукоять',
        files: [
          { name: '01_Вопросы_поставщику.txt', content: cleanQuestions },
        ],
      }),
    );
    expect(res.errors).toEqual([]);
  });

  it('generic-smell knife fixture flags each new warning', () => {
    const badReport = pad(
      [
        '📦 Кухонный нож из нержавеющей стали 3CR13',
        'Источник: 1688',
        '📌 Товар',
        '• Выбранный SKU: кухонный нож из нержавеющей стали для готовки нож',
        '• SKU: 1 вариант · вариант',
      ].join('\n'),
      20,
    );
    const badQuestions = pad(
      [
        '01_Вопросы_поставщику.txt',
        '1. Подтвердите цену выбранного SKU: кухонный нож из нержавеющей стали для готовки — 5,01 ¥',
        '2. Материал лезвия?',
      ].join('\n'),
    );
    const badSeo = pad(
      [
        '## Название',
        'Кухонный нож 420',
        '',
        '## Буллеты',
        '1. универсальный дизайн под разные интерьеры',
        '2. удобно дарить и хранить',
      ].join('\n'),
      45,
    );
    const res = validateProcurementResult(
      baseInput({
        productKind: 'knife',
        productDetailsText: badReport,
        mainReportText: badReport,
        seoDraftMd: badSeo,
        files: [{ name: '01_Вопросы_поставщику.txt', content: badQuestions }],
      }),
    );
    expect(res.warnings.some((w) => /steel grade leaked into title/.test(w))).toBe(true);
    expect(
      res.warnings.some((w) => /SKU echoes product title, not a real variant/.test(w)),
    ).toBe(true);
    expect(
      res.warnings.some((w) => /price question embeds oversized SKU string/.test(w)),
    ).toBe(true);
    expect(
      res.warnings.some((w) => /meaningless single-variant SKU label/.test(w)),
    ).toBe(true);
    expect(
      res.warnings.some((w) =>
        /generic filler bullets for a specific product kind/.test(w),
      ),
    ).toBe(true);
  });

  it('clean knife fixture fires none of the new warnings and zero errors', () => {
    const goodReport = pad(
      [
        '📦 Кухонный нож из нержавеющей стали',
        'Источник: 1688',
        '📌 Товар',
        '• Выбранный SKU: единственный вариант',
        '• Материал: нержавеющая сталь — подтвердить',
      ].join('\n'),
      20,
    );
    const goodQuestions = pad(
      [
        '01_Вопросы_поставщику.txt',
        '1. Подтвердите цену выбранного SKU — 5,01 ¥.',
        '2. Из какой стали изготовлено лезвие?',
      ].join('\n'),
    );
    const goodSeo = pad(
      [
        '## Название',
        'Кухонный нож из нержавеющей стали',
        '',
        '## Буллеты',
        '1. Сталь клинка держит заточку при повседневной готовке.',
        '2. Клинок и рукоять удобны для нарезки овощей и мяса.',
      ].join('\n'),
      45,
    );
    const res = validateProcurementResult(
      baseInput({
        productKind: 'knife',
        productDetailsText: goodReport,
        mainReportText: goodReport,
        seoDraftMd: goodSeo,
        selectedSkuText: 'единственный вариант',
        files: [{ name: '01_Вопросы_поставщику.txt', content: goodQuestions }],
      }),
    );
    expect(res.errors).toEqual([]);
    const newWarnRe =
      /steel grade leaked into title|SKU echoes product title|price question embeds oversized SKU string|meaningless single-variant SKU label|generic filler bullets/;
    expect(res.warnings.some((w) => newWarnRe.test(w))).toBe(false);
  });

  it('legit "Название CN:" title does not trip wrong-product rule', () => {
    const cn = pad(
      [
        '1. Из какой стали лезвие?',
        '   CN: 刀刃采用什么钢材？',
        'Название CN: 厨房菜刀',
      ].join('\n'),
    );
    const res = validateProcurementResult(
      baseInput({ files: [{ name: '01_Вопросы_поставщику.txt', content: cn }] }),
    );
    expect(
      res.errors.some((e) => /wrong-product or meta CN question/.test(e)),
    ).toBe(false);
  });
});
