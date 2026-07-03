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
    const primaryRec = primary as unknown as Record<string, unknown>;
    const fallbackRec = fallback as unknown as Record<string, unknown>;
    const primaryDraft = primaryRec.procurementProfileDraft;
    const fallbackDraft = fallbackRec.procurementProfileDraft;
    const primaryLogistics = primaryRec.logistics;
    const fallbackLogistics = fallbackRec.logistics;

    const merged = {
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
    } as ProductContext & Record<string, unknown>;

    // Explicitly carry through the product-specific procurement draft (domainRules,
    // buyerMustCheck, etc.). The role-based primary context does not produce it, so
    // without this the LLM-derived draft could be lost on any future merge change.
    const carriedDraft = primaryDraft ?? fallbackDraft;
    if (carriedDraft !== undefined) merged.procurementProfileDraft = carriedDraft;
    const carriedLogistics = primaryLogistics ?? fallbackLogistics;
    if (carriedLogistics !== undefined) merged.logistics = carriedLogistics;

    return merged;
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
    runLegacyCanonicalizerFallback(raw).catch((e) => {
      console.error('[role-pipeline] legacy canonicalizer failed:', (e as Error)?.message);
      return null;
    }),
    extractProductFacts(raw as any).catch((e) => {
      console.error('[role-pipeline] fact extractor failed:', (e as Error)?.message);
      return null;
    }),
    classifyProductCapabilities(raw as any).catch((e) => {
      console.error('[role-pipeline] capability classifier failed:', (e as Error)?.message);
      return null;
    }),
    runCanonicalizerClassification(raw).catch((e) => {
      console.error('[role-pipeline] canonicalizer classification failed:', (e as Error)?.message);
      return null;
    }),
    runCanonicalizerSkuResolution(raw).catch((e) => {
      console.error('[role-pipeline] canonicalizer sku resolution failed:', (e as Error)?.message);
      return null;
    }),
    runCanonicalizerPolicyGuard(raw).catch((e) => {
      console.error('[role-pipeline] canonicalizer policy guard failed:', (e as Error)?.message);
      return null;
    }),
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

  // Diagnostic: surface the exact case that shipped a knife with generic questions —
  // the LLM layer produced no product-specific domainRules, so downstream builders
  // silently fall back to generic templates. Make this visible in Railway logs.
  const resolvedDraft = (resolvedContext as unknown as Record<string, unknown> | null)
    ?.procurementProfileDraft as
    | { domainRules?: { buyerMustCheck?: unknown[] } }
    | undefined;
  if (!resolvedDraft?.domainRules?.buyerMustCheck?.length) {
    console.warn(
      '[role-pipeline] no LLM domainRules.buyerMustCheck — report will use generic fallback',
      { primarySource },
    );
  }

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
