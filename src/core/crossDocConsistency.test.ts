import { describe, expect, it } from 'vitest';
import { validateCrossDocumentConsistency } from './crossDocConsistency';

describe('validateCrossDocumentConsistency', () => {
  it('flags volumetric weight without packaging basis', () => {
    const issues = validateCrossDocumentConsistency({
      docs: [
        {
          name: '03_ТЗ_карго.md',
          content: 'Объёмный вес: 188,6 кг\nГабариты: 125×92×82 см',
        },
      ],
    });
    expect(issues.some((item) => item.field === 'volumetric_weight')).toBe(true);
  });

  it('flags mixed unknown and numeric weight across docs', () => {
    const issues = validateCrossDocumentConsistency({
      docs: [
        { name: '02_ТЗ_байеру.md', content: 'Вес: не указан' },
        { name: '03_ТЗ_карго.md', content: 'Вес: 1,8 кг' },
      ],
    });
    expect(issues.some((item) => item.field === 'weight')).toBe(true);
  });
});
