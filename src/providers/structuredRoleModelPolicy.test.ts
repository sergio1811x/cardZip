import { describe, expect, it } from 'vitest';
import { CLASSIFIER_MODELS } from './canonicalizerClassificationProvider';
import { SKU_MODELS } from './canonicalizerSkuProvider';
import { POLICY_MODELS } from './canonicalizerPolicyProvider';

const expectedOrder = [
  'openai/gpt-5-mini',
  'qwen/qwen3.7-plus',
  'google/gemini-3.1-flash-lite',
];

describe('structured role model policy', () => {
  it.each([
    ['classification', CLASSIFIER_MODELS],
    ['SKU resolution', SKU_MODELS],
    ['policy guard', POLICY_MODELS],
  ])('%s prioritizes accuracy before the fast fallback', (_stage, models) => {
    expect(models).toEqual(expectedOrder);
  });
});
