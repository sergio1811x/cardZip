import { describe, expect, it } from 'vitest';
import { buildUserFacingAnalysis } from './userFacingAnalysis';

describe('user-facing analysis delivery contract', () => {
  it('does not block a parsed product when price is missing', () => {
    const analysis = buildUserFacingAnalysis(
      { product: { titleRu: 'Тестовый товар', titleCn: '产品', moq: 1 } },
      { sourceUrl: 'https://detail.1688.com/offer/1.html', creditsRemaining: 5 },
    );

    expect(analysis.fatalIssues).toEqual([]);
    expect(analysis.status).toBe('needs_supplier_data');
    expect(analysis.mainText).toContain('Цена: нужно уточнить');
    expect(analysis.mainText).toContain('Статус: нужны данные поставщика');
    expect(analysis.docs.map((d) => d.filename)).toEqual([
      '00_Инструкция.txt',
      '01_Вопросы_поставщику.txt',
      '02_ТЗ_байеру.md',
      '03_ТЗ_карго.md',
      '04_Чеклист_образца.md',
      '05_SEO_черновик.md',
    ]);
  });

  it('blocks only an object that cannot be identified as a product at all', () => {
    const analysis = buildUserFacingAnalysis({}, { sourceUrl: 'https://detail.1688.com/offer/1.html' });

    expect(analysis.status).toBe('fatal_error');
    expect(analysis.fatalIssues.map((i) => i.code)).toContain('missing_product');
  });
});
