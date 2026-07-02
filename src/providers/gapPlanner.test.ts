import { describe, expect, it } from 'vitest';
import { parseLlmJson, GapPlannerResultSchema } from '../core/llmSchemas';

describe('GapPlannerResultSchema', () => {
  it('parses valid planner payload with defaults', () => {
    const parsed = parseLlmJson(
      GapPlannerResultSchema,
      JSON.stringify({
        missingFacts: ['вес с упаковкой'],
        supplierQuestionsRu: ['Укажите вес одной единицы с упаковкой.'],
      }),
    );
    expect(parsed?.missingFacts).toEqual(['вес с упаковкой']);
    expect(parsed?.requiredConfirmations).toEqual([]);
  });
});
