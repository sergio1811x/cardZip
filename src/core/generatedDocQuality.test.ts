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

function pad(text: string, min: number): string {
  const lines = text.split('\n');
  while (lines.length < min) lines.push('');
  return lines.join('\n');
}

// ---- Fixtures ----

// Cargo doc with the exact shipped knife contradiction: Дополнительно says no
// restrictions while Что нужно запросить requests blade/острые items.
const badCargoContradiction = pad(
  [
    '# 03_ТЗ_карго',
    '',
    '## Товар',
    'Нож кухонный',
    '',
    '## Что нужно запросить',
    '- Вес с упаковкой',
    '- Габариты коробки',
    '- Уточните упаковку острых лезвий для перевозки',
    '',
    '## Дополнительно',
    'специальных ограничений не найдено',
    '',
    '## Текущий статус',
    'нужен вес с упаковкой',
    '',
    '## Важно',
    'уточните ограничения у карго',
  ].join('\n'),
  30,
);

// Questions doc whose CN section is only the fallback.
const badQuestionsEmptyCn = pad(
  [
    '# 01_Вопросы_поставщику',
    '',
    '## Русская версия',
    '1. Подтвердите цену за штуку.',
    '2. Уточните минимальный заказ (MOQ).',
    '3. Какой материал верха и подошвы?',
    '4. Пришлите реальные фото пары и упаковки.',
    '',
    '## Китайская версия',
    'Китайская версия не сформирована.',
  ].join('\n'),
  20,
);

describe('generated doc quality — NEW risk rules (BAD)', () => {
  it('flags cargo self-contradiction (Дополнительно none vs hazard request)', () => {
    const res = validateProcurementResult(
      baseInput({
        productKind: 'knife',
        files: [{ name: '03_ТЗ_карго.md', content: badCargoContradiction }],
      }),
    );
    expect(
      res.warnings.some((w) =>
        /says no restrictions while requesting hazard-specific items/.test(w),
      ),
    ).toBe(true);
  });

  it('flags empty CN supplier questions', () => {
    const res = validateProcurementResult(
      baseInput({
        files: [{ name: '01_Вопросы_поставщику.txt', content: badQuestionsEmptyCn }],
      }),
    );
    expect(
      res.warnings.some((w) => /CN supplier questions empty/.test(w)),
    ).toBe(true);
  });
});

// ---- GOOD: successful LLM generation, product-specific content ----

const goodSeo = pad(
  [
    '## Название',
    'Зонт складной автоматический с ветрозащитой',
    '',
    '## Описание',
    'Компактный складной зонт с автоматическим механизмом открытия и закрытия.',
    'Прочный каркас на 8 спиц из стекловолокна выдерживает порывы ветра.',
    'Купол из плотного полиэстера быстро сохнет, в комплекте чехол для переноски.',
    '',
    '## Буллеты',
    '- Автоматическое открытие и закрытие одной кнопкой',
    '- Ветроустойчивый каркас на 8 спиц из стекловолокна',
    '- Компактный размер в сложенном виде помещается в сумку',
    '- Плотный купол из полиэстера с водоотталкивающей пропиткой',
    '- В комплекте защитный чехол для хранения',
    '',
    '## Характеристики',
    '| Параметр | Значение |',
    '| --- | --- |',
    '| Количество спиц | 8 |',
    '| Материал купола | полиэстер |',
    '',
    '## Ключевые слова',
    'зонт, зонт складной, зонт автоматический, зонт мужской, зонт женский, ветрозащитный зонт, компактный зонт, зонт с чехлом, зонт от дождя, прочный зонт',
    '',
    '## Что уточнить перед публикацией',
    'Точный вес и диаметр купола уточните у поставщика.',
  ].join('\n'),
  45,
);

const goodQuestions = pad(
  [
    '# 01_Вопросы_поставщику',
    '',
    '## Русская версия',
    '1. Подтвердите цену за штуку и MOQ.',
    '2. Какой материал купола и спиц?',
    '3. Механизм только открытие или открытие и закрытие?',
    '4. Пришлите вес с упаковкой.',
    '',
    '## Китайская версия',
    '1. 请确认单价和起订量。',
    '2. 伞面和支架的材质是什么？',
    '3. 机械是自动开还是自动开合？',
    '4. 请提供含包装重量。',
  ].join('\n'),
  20,
);

const goodCargo = pad(
  [
    '# 03_ТЗ_карго',
    '',
    '## Товар',
    'Зонт складной автоматический',
    '',
    '## Что нужно запросить',
    '- Вес с упаковкой',
    '- Габариты коробки в сложенном виде',
    '- Количество штук в коробе',
    '',
    '## Дополнительно',
    '- Уточните упаковку для защиты механизма от повреждений',
    '- Проверьте, нет ли пружинного механизма, требующего особой маркировки',
    '',
    '## Текущий статус',
    'нужен вес с упаковкой',
    '',
    '## Важно',
    'подтвердите габариты у поставщика',
  ].join('\n'),
  30,
);

describe('generated doc quality — successful LLM generation (GOOD)', () => {
  const res = validateProcurementResult(
    baseInput({
      productKind: 'umbrella',
      seoDraftMd: goodSeo,
      files: [
        { name: '05_SEO_черновик.md', content: goodSeo },
        { name: '01_Вопросы_поставщику.txt', content: goodQuestions },
        { name: '03_ТЗ_карго.md', content: goodCargo },
      ],
    }),
  );

  it('has zero errors', () => {
    expect(res.errors).toEqual([]);
  });

  it('does not fire the new cargo-contradiction warning', () => {
    expect(
      res.warnings.some((w) =>
        /says no restrictions while requesting hazard-specific items/.test(w),
      ),
    ).toBe(false);
  });

  it('does not fire the empty-CN warning', () => {
    expect(
      res.warnings.some((w) => /CN supplier questions empty/.test(w)),
    ).toBe(false);
  });

  it('does not fire thin-keywords warning', () => {
    expect(res.warnings.some((w) => /thin SEO keywords/.test(w))).toBe(false);
  });
});

// ---- HONEST FLOOR: LLM failed, honest-generic deterministic content ----

const honestSeo = pad(
  [
    '## Название',
    'Зонт складной',
    '',
    '## Описание',
    'Складной зонт. Точные характеристики уточните у поставщика.',
    '',
    '## Буллеты',
    '- Точные размеры уточните у поставщика',
    '- Материал уточните у поставщика',
    '- Механизм уточните у поставщика',
    '- Вес уточните у поставщика',
    '- Комплектацию уточните у поставщика',
    '',
    '## Характеристики',
    'Точные характеристики уточните у поставщика',
    '',
    '## Ключевые слова',
    'зонт',
  ].join('\n'),
  45,
);

const honestQuestions = pad(
  [
    '# 01_Вопросы_поставщику',
    '',
    '## Русская версия',
    '1. Подтвердите цену за штуку.',
    '2. Уточните MOQ.',
    '3. Пришлите вес с упаковкой.',
    '',
    '## Китайская версия',
    'Китайская версия не сформирована.',
  ].join('\n'),
  20,
);

const honestCargo = pad(
  [
    '# 03_ТЗ_карго',
    '',
    '## Товар',
    'Зонт складной',
    '',
    '## Что нужно запросить',
    '- Вес с упаковкой',
    '- Габариты коробки',
    '',
    '## Дополнительно',
    'специальных ограничений не найдено',
    '',
    '## Текущий статус',
    'нужен вес с упаковкой',
    '',
    '## Важно',
    'уточните ограничения у карго',
  ].join('\n'),
  30,
);

describe('generated doc quality — honest floor (LLM failed)', () => {
  const res = validateProcurementResult(
    baseInput({
      productKind: 'umbrella',
      seoDraftMd: honestSeo,
      files: [
        { name: '05_SEO_черновик.md', content: honestSeo },
        { name: '01_Вопросы_поставщику.txt', content: honestQuestions },
        { name: '03_ТЗ_карго.md', content: honestCargo },
      ],
    }),
  );

  it('produces no ERRORS (honest floor must pass the gate)', () => {
    expect(res.errors).toEqual([]);
    expect(res.passed).toBe(true);
  });

  it('does not fire the cargo-contradiction warning (no hazard request here)', () => {
    expect(
      res.warnings.some((w) =>
        /says no restrictions while requesting hazard-specific items/.test(w),
      ),
    ).toBe(false);
  });
});
