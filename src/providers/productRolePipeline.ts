import type { ProductContext } from '../types';
import { runLegacyCanonicalizerFallback, type RawProductForCanonicalizer } from './productCanonicalizer';
import { extractProductFacts } from './factExtractor';
import { classifyProductCapabilities } from './capabilityClassifier';
import { buildCanonicalizerClassificationInput } from './canonicalizerClassifier';
import { buildCanonicalizerSkuResolutionInput } from './canonicalizerSkuResolver';
import { buildCanonicalizerPolicyInput } from './canonicalizerPolicyBuilder';
import { runCanonicalizerClassification } from './canonicalizerClassificationProvider';
import { runCanonicalizerSkuResolution } from './canonicalizerSkuProvider';
import { runCanonicalizerPolicyGuard } from './canonicalizerPolicyProvider';
import { buildContextFromRoleOutputs } from './canonicalizerContextBuilder';

export interface ProductRolePipelineResult {
  productContext: ProductContext | null;
  factSheet: Awaited<ReturnType<typeof extractProductFacts>> | null;
  categoryPolicy: Awaited<ReturnType<typeof classifyProductCapabilities>> | null;
  primarySource: 'role_outputs' | 'canonicalizer_fallback';
  roleInputs: {
    classification: ReturnType<typeof buildCanonicalizerClassificationInput>;
    skuResolution: ReturnType<typeof buildCanonicalizerSkuResolutionInput>;
    policy: ReturnType<typeof buildCanonicalizerPolicyInput>;
  };
  roleOutputs: {
    classification: Awaited<ReturnType<typeof runCanonicalizerClassification>>;
    skuResolution: Awaited<ReturnType<typeof runCanonicalizerSkuResolution>>;
    policy: Awaited<ReturnType<typeof runCanonicalizerPolicyGuard>>;
  };
}

function mergeContexts(
  primary: ProductContext | null,
  fallback: ProductContext | null,
): ProductContext | null {
  if (primary && fallback) {
    return {
      ...fallback,
      ...primary,
      identity: { ...fallback.identity, ...primary.identity },
      titles: { ...fallback.titles, ...primary.titles },
      facts: Object.keys(primary.facts ?? {}).length ? primary.facts : fallback.facts,
      sku: { ...fallback.sku, ...primary.sku },
      price: { ...fallback.price, ...primary.price },
      wbSearch: { ...fallback.wbSearch, ...primary.wbSearch },
      seoPolicy: { ...fallback.seoPolicy, ...primary.seoPolicy },
      supplierQuestions: {
        ru: primary.supplierQuestions?.ru?.length ? primary.supplierQuestions.ru : fallback.supplierQuestions.ru,
        cn: primary.supplierQuestions?.cn?.length ? primary.supplierQuestions.cn : fallback.supplierQuestions.cn,
      },
      riskTags: primary.riskTags?.length ? primary.riskTags : fallback.riskTags,
      dataQuality: { ...fallback.dataQuality, ...primary.dataQuality },
    };
  }

  return primary ?? fallback;
}

export async function runProductRolePipeline(
  raw: RawProductForCanonicalizer,
): Promise<ProductRolePipelineResult> {
  const classification = buildCanonicalizerClassificationInput(raw);
  const skuResolution = buildCanonicalizerSkuResolutionInput(raw);
  const policy = buildCanonicalizerPolicyInput(raw);

  const [canonicalizerFallbackContext, factSheet, categoryPolicy, classificationOutput, skuResolutionOutput, policyOutput] = await Promise.all([
    runLegacyCanonicalizerFallback(raw).catch(() => null),
    extractProductFacts(raw as any).catch(() => null),
    classifyProductCapabilities(raw as any).catch(() => null),
    runCanonicalizerClassification(raw).catch(() => null),
    runCanonicalizerSkuResolution(raw).catch(() => null),
    runCanonicalizerPolicyGuard(raw).catch(() => null),
  ]);

  const roleBasedContext = buildContextFromRoleOutputs(raw, {
    classification: classificationOutput,
    skuResolution: skuResolutionOutput,
    policy: policyOutput,
  });
  const resolvedContext = mergeContexts(roleBasedContext, canonicalizerFallbackContext);
  const primarySource: ProductRolePipelineResult['primarySource'] = roleBasedContext
    ? 'role_outputs'
    : 'canonicalizer_fallback';

  return {
    productContext: resolvedContext,
    factSheet,
    categoryPolicy,
    primarySource,
    roleInputs: {
      classification,
      skuResolution,
      policy,
    },
    roleOutputs: {
      classification: classificationOutput,
      skuResolution: skuResolutionOutput,
      policy: policyOutput,
    },
  };
}
