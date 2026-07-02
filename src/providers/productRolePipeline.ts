import type { ProductContext } from '../types';
import { canonicalizeProduct, type RawProductForCanonicalizer } from './productCanonicalizer';
import { extractProductFacts } from './factExtractor';
import { classifyProductCapabilities } from './capabilityClassifier';
import { buildCanonicalizerClassificationInput } from './canonicalizerClassifier';
import { buildCanonicalizerSkuResolutionInput } from './canonicalizerSkuResolver';
import { buildCanonicalizerPolicyInput } from './canonicalizerPolicyBuilder';
import { runCanonicalizerClassification } from './canonicalizerClassificationProvider';
import { runCanonicalizerSkuResolution } from './canonicalizerSkuProvider';
import { runCanonicalizerPolicyGuard } from './canonicalizerPolicyProvider';

export interface ProductRolePipelineResult {
  productContext: Awaited<ReturnType<typeof canonicalizeProduct>>;
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

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: unknown[], limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function buildRoleBasedContext(
  raw: RawProductForCanonicalizer,
  input: {
    classification: Awaited<ReturnType<typeof runCanonicalizerClassification>>;
    skuResolution: Awaited<ReturnType<typeof runCanonicalizerSkuResolution>>;
    policy: Awaited<ReturnType<typeof runCanonicalizerPolicyGuard>>;
  },
): ProductContext | null {
  const finalKind = normalizeText(input.classification?.finalKind);
  if (!finalKind) return null;

  const cleanRu = normalizeText(raw.titleRu) || normalizeText(raw.titleEn) || finalKind;
  const shortRu = finalKind.length <= 80 ? finalKind : finalKind.slice(0, 80).trim();
  const categoryType = normalizeText(input.classification?.categoryType) || 'other';
  const selectedSku = normalizeText(input.skuResolution?.selectedSkuResolved ?? raw.selectedSkuName);
  const skuOptions = uniqueStrings([
    selectedSku,
    ...(input.skuResolution?.candidateColors ?? []),
    ...(input.skuResolution?.candidateModels ?? []),
    ...((raw.normalizedSkuTable ?? raw.skus ?? []).map((item: any) => item.label ?? item.name)),
  ], 20);

  return {
    offerId: raw.offerId,
    identity: {
      productType: finalKind,
      coreObject: finalKind,
      categoryType: categoryType as ProductContext['identity']['categoryType'],
      useCases: [],
      notThis: [],
      audience: 'неизвестно',
      season: 'неизвестно',
      gender: 'неизвестно',
    },
    titles: {
      titleCn: normalizeText(raw.titleCn),
      cleanRu,
      shortRu,
      titleForSeo: cleanRu,
    },
    facts: Object.fromEntries(
      uniqueStrings([
        ...(input.skuResolution?.candidateModels ?? []),
        ...(input.skuResolution?.candidateColors ?? []),
        ...(input.skuResolution?.candidatePlugStandards ?? []),
      ], 8).map((value, index) => [`role_fact_${index + 1}`, value]),
    ),
    sku: {
      hasMultipleSku: skuOptions.length > 1,
      skuCount: skuOptions.length,
      knownOptions: skuOptions,
      needsSelection: !selectedSku && skuOptions.length > 1,
    },
    price: {
      visiblePriceCny: typeof raw.price === 'number' && raw.price > 0 ? raw.price : null,
      minPriceCny: typeof raw.price === 'number' && raw.price > 0 ? raw.price : null,
      maxPriceCny: typeof raw.price === 'number' && raw.price > 0 ? raw.price : null,
      source: typeof raw.price === 'number' && raw.price > 0 ? 'visible_1688_price' : 'unknown',
      needsConfirmation: true,
    },
    conflicts: [],
    missingCritical: uniqueStrings([
      !(raw.weightKg && raw.weightKg > 0) ? 'вес с упаковкой' : '',
      !selectedSku && skuOptions.length > 1 ? 'выбранный SKU' : '',
      ...(input.policy?.requiredChecks ?? []),
    ], 12),
    wbSearch: {
      coreQuery: shortRu,
      queryLadder: uniqueStrings([shortRu, cleanRu], 8),
      mustInclude: [],
      mustExclude: [],
      directMatchRules: [],
      rejectRules: [],
    },
    seoPolicy: {
      allowedClaims: [],
      forbiddenClaims: uniqueStrings(input.policy?.forbiddenClaims ?? [], 20),
    },
    supplierQuestions: {
      ru: uniqueStrings(input.policy?.requiredChecks ?? [], 10),
      cn: [],
    },
    riskTags: uniqueStrings([
      ...(input.policy?.logisticsWarnings ?? []),
      input.classification?.reason ?? '',
    ], 10),
    dataQuality: {
      score: input.classification && input.classification.confidence >= 0.75 ? 6 : 4,
      status: input.classification && input.classification.confidence >= 0.75 ? 'working_hypothesis' : 'draft',
      explanation: uniqueStrings([
        input.classification?.reason ?? '',
        input.skuResolution?.reason ?? '',
        input.policy?.reason ?? '',
      ], 3).join(' | '),
    },
  };
}

export async function runProductRolePipeline(
  raw: RawProductForCanonicalizer,
): Promise<ProductRolePipelineResult> {
  const classification = buildCanonicalizerClassificationInput(raw);
  const skuResolution = buildCanonicalizerSkuResolutionInput(raw);
  const policy = buildCanonicalizerPolicyInput(raw);

  const [canonicalizerFallbackContext, factSheet, categoryPolicy, classificationOutput, skuResolutionOutput, policyOutput] = await Promise.all([
    canonicalizeProduct(raw).catch(() => null),
    extractProductFacts(raw as any).catch(() => null),
    classifyProductCapabilities(raw as any).catch(() => null),
    runCanonicalizerClassification(raw).catch(() => null),
    runCanonicalizerSkuResolution(raw).catch(() => null),
    runCanonicalizerPolicyGuard(raw).catch(() => null),
  ]);

  const roleBasedContext = buildRoleBasedContext(raw, {
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
