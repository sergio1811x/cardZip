import { describe, expect, it } from 'vitest';
import { parseLlmJson, ConsistencyAuditResultSchema } from '../core/llmSchemas';

describe('ConsistencyAuditResultSchema', () => {
  it('parses valid audit payload', () => {
    const parsed = parseLlmJson(
      ConsistencyAuditResultSchema,
      JSON.stringify({
        decision: 'FIX_REQUIRED',
        summary: 'Есть конфликт по весу.',
        issues: ['Вес товара и вес с упаковкой смешаны.'],
        requiredEdits: [
          {
            artifact: 'cargoBrief',
            reason: 'Нельзя считать логистику по размерам товара.',
            instruction: 'Убрать объёмный вес до подтверждения размеров упаковки.',
          },
        ],
      }),
    );
    expect(parsed?.decision).toBe('FIX_REQUIRED');
    expect(parsed?.requiredEdits[0]?.artifact).toBe('cargoBrief');
  });
});
