import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSeoDraftFromProfile } from './procurementProfile';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('MVP paid copy', () => {
  it('does not sell WB analogs, ROI or profitability in payment/start screens', () => {
    const text = [
      read('src/bot/handlers/start.ts'),
      read('src/bot/handlers/upgrade.ts'),
      read('src/services/paymentService.ts'),
    ].join('\n');

    expect(text).not.toMatch(/аналог[а-яё\s]+на\s+WB/i);
    expect(text).not.toMatch(/ориентир\s+по\s+рынку\s+WB/i);
    expect(text).not.toMatch(/ROI/i);
    expect(text).not.toMatch(/прибыльн[а-яё]*\s+товар/i);
  });
});

describe('SEO draft quality', () => {
  it('keeps five clean bullets and moves uncertain claims into clarification blocks', () => {
    const text = buildSeoDraftFromProfile({
      titleRu: 'Детская электрическая зубная щетка с мягкой щетиной на батарейках',
      productKind: 'small_appliance',
      priceYuan: 6.9,
      moq: 1,
      skus: [{ name: 'A6 синий2 -', priceYuan: 6.9 }],
      selectedSkuName: 'A6 синий2 -',
      attributes: [{ name: '材质', value: '塑料' }],
    });

    const bulletSection = text.match(/## Буллеты\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';
    expect(bulletSection.match(/^\d+\.\s+/gm)?.length).toBe(5);
    expect(text).not.toMatch(/для ежедневная/i);
    expect(text).not.toMatch(/карточк[еаи]\s+1688/i);
    expect(text).not.toMatch(/WB\/Ozon/i);
    expect(text).toMatch(/Нельзя писать как факт/);
    expect(text).toMatch(/Что уточнить перед публикацией/);
  });
});
