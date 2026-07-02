import { describe, expect, it } from 'vitest';
import { buildCanonicalizerClassificationInput } from './canonicalizerClassifier';
import { buildCanonicalizerSkuResolutionInput } from './canonicalizerSkuResolver';
import { buildCanonicalizerPolicyInput } from './canonicalizerPolicyBuilder';
import { runProductRolePipeline } from './productRolePipeline';
import type { RawProductForCanonicalizer } from './productCanonicalizer';

function buildRaw(): RawProductForCanonicalizer {
  return {
    offerId: '1',
    titleCn: '工厂批发 PVC 充气沙发',
    titleRu: 'Надувное кресло',
    titleEn: 'inflatable chair',
    categoryName: 'home',
    attributes: [{ name: '材质', value: 'PVC' }],
    skus: [{ name: 'коричневый с насосом', price: 42 }],
    normalizedSkuTable: [{ id: '1', label: 'коричневый с насосом', priceYuan: 42 }],
    selectedSkuName: 'коричневый с насосом',
  };
}

describe('canonicalizer role parts', () => {
  it('builds classification input', () => {
    const result = buildCanonicalizerClassificationInput(buildRaw());
    expect(result.promptSegment).toContain('CLASSIFICATION INPUT');
    expect(result.textHints.length).toBeGreaterThan(0);
  });

  it('builds sku resolution input', () => {
    const result = buildCanonicalizerSkuResolutionInput(buildRaw());
    expect(result.selectedSkuLabel).toBe('коричневый с насосом');
    expect(result.skuOptions[0]).toContain('коричневый');
  });

  it('builds policy input', () => {
    const result = buildCanonicalizerPolicyInput(buildRaw());
    expect(result.promptSegment).toContain('POLICY INPUT');
  });

  it('returns role inputs and role outputs containers from pipeline', async () => {
    const result = await runProductRolePipeline(buildRaw());
    expect(result.roleInputs.classification.promptSegment).toContain('CLASSIFICATION INPUT');
    expect(result.roleOutputs).toBeDefined();
  });

  it('prefers role outputs as primary source when role-based context is available', async () => {
    const result = await runProductRolePipeline(buildRaw());
    expect(['role_outputs', 'canonicalizer_fallback']).toContain(result.primarySource);
  });
});
