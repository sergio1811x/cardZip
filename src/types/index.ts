// ─── Product ──────────────────────────────────────────────────────────────────

export type Platform = '1688' | 'taobao' | 'tmall';

export interface PriceRange {
  minQty: number;
  maxQty: number;
  price: number;
}

export interface ProductAttribute {
  name: string;
  value: string;
}

export interface ProductSku {
  name: string;
  price?: number;
  stock?: number;
  image?: string;
}

export type QuoteType = 'direct' | 'by_sku' | 'by_volume' | 'unknown';

export interface NormalizedSkuVariant {
  name: string;
  price?: number;
  stock?: number;
  image?: string;
}

export interface NormalizedPriceInfo {
  quoteType: QuoteType;
  displayPriceYuan: number;
  directPriceYuan?: number;
  promotionPriceYuan?: number;
  skuMinPriceYuan?: number;
  skuMaxPriceYuan?: number;
  volumeMinPriceYuan?: number;
  volumeMaxPriceYuan?: number;
  selectedSkuName?: string;
  selectedSkuId?: string;
  selectedSkuPriceYuan?: number;
  selectedSkuImage?: string;
  priceRanges?: PriceRange[];
  rawPriceFields: string[];
  isEstimatedPrice?: boolean;
  estimateSource?: 'min_tiered' | 'min_sku' | 'promo' | 'direct';
}

export interface NormalizedAttributeSummaryItem {
  label: string;
  value: string;
}

export interface Normalized1688Debug {
  quoteType: QuoteType;
  rawPriceFields: string[];
  skuCount: number;
  attributesCount: number;
  imageCount: number;
  sellerType?: string;
  extraInfoKeys: string[];
  missingCriticalFields: string[];
}

export interface Normalized1688Data {
  pricing: NormalizedPriceInfo;
  moq?: number;
  skuCount: number;
  skuVariants: NormalizedSkuVariant[];
  supplierType?: 'factory' | 'merchant' | 'seller';
  salesCount?: number;
  repurchaseRate?: string;
  imageCount: number;
  images: string[];
  weightKg?: number;
  attributes: ProductAttribute[];
  keyAttributes: NormalizedAttributeSummaryItem[];
  sellerExtraInfo?: Record<string, unknown>;
  soldCountText?: string;
  debug: Normalized1688Debug;
}

export interface SupplierExtra {
  dropshipping?: boolean;
  mixOrder?: boolean;
  freeReturn7d?: boolean;
  selectedSource?: boolean;
}

export interface RawProduct1688 {
  productId: string;
  platform: Platform;
  titleCn: string;
  titleEn?: string;
  description?: string;
  priceYuan: number;
  priceRange?: PriceRange[];
  moq: number;
  weightKg: number;
  images: string[];
  supplierName: string;
  supplierRating?: number;
  supplierType?: 'factory' | 'merchant' | 'seller';
  mainImageUrl: string;
  sold?: number;
  stock?: number;
  categoryName?: string;
  attributes?: ProductAttribute[];
  skus?: ProductSku[];
  supplierExtra?: SupplierExtra;
  priceIsRange?: boolean;
  selectedSkuName?: string;
  normalized1688: Normalized1688Data;
}

// ─── Product Context (Canonicalizer output) ────────────────────────────────

export interface ProductContext {
  offerId: string;

  identity: {
    productType: string;
    coreObject: string;
    categoryType: string;
    /** Free-form domain inferred by LLM, e.g. exact procurement niche. Not a hardcoded enum. */
    domainKind?: string;
    useCases: string[];
    notThis: string[];
    audience: string;
    season: string;
    gender: string;
  };

  titles: {
    titleCn: string;
    cleanRu: string;
    shortRu: string;
    wbTitleDraft: string;
  };

  facts: Record<string, string>;

  sku: {
    hasMultipleSku: boolean;
    skuCount: number;
    knownOptions: string[];
    needsSelection: boolean;
  };

  price: {
    visiblePriceCny: number | null;
    minPriceCny: number | null;
    maxPriceCny: number | null;
    source: string;
    needsConfirmation: boolean;
  };

  conflicts: Array<{
    field: string;
    problem: string;
    severity: string;
    action: string;
  }>;

  missingCritical: string[];

  wbSearch: {
    coreQuery: string;
    queryLadder: string[];
    mustInclude: string[];
    mustExclude: string[];
    directMatchRules: string[];
    rejectRules: string[];
  };

  seoPolicy: {
    allowedClaims: string[];
    forbiddenClaims: string[];
  };

  supplierQuestions: {
    ru: string[];
    cn: string[];
  };

  riskTags: string[];

  dataQuality: {
    score: number;
    status: string;
    explanation: string;
  };

  /** LLM-generated, domain-specific procurement rules. This is intentionally dynamic. */
  procurementProfileDraft?: Record<string, unknown>;
  productKindClassifier?: Record<string, unknown>;
}

// ─── Analysis Snapshot (step4 → step5) ─────────────────────────────────────

export interface AnalysisSnapshot {
  offerId: string;
  sourceUrl: string;
  productContext: ProductContext | null;

  supplier: {
    name: string;
    type: string;
    rating: number | null;
    orders: number | null;
    moq: number | null;
  };

  purchasePrice: {
    valueCny: number | null;
    displayLabel: string;
    source: string;
    needsConfirmation: boolean;
  };

  weight: {
    valueKg: number | null;
    source: string;
  };

  market: {
    confirmedCount: number;
    medianPriceRub: number | null;
    marketConfirmed: boolean;
    wb429: boolean;
  };

  economics: {
    status: string;
    costRub: number | null;
    roiPercent: number | null;
    canShowRoi: boolean;
    missing: string[];
  };

  missingData: string[];
  riskFlags: string[];
}

export interface GeneratedArtifacts {
  userCard: string;
  seoTitle: string;
  seoDescription: string;
  seoBullets: string[];
  seoKeywords: string[];
  seoCharacteristics: Record<string, string>;
  buyerBrief: string;
  supplierQuestionsRu: string[];
  supplierQuestionsCn: string[];
}

export interface QaResult {
  decision: 'PASS' | 'FIX_REQUIRED' | 'BLOCK';
  qualityScore: number;
  issues: string[];
  fixedArtifacts?: GeneratedArtifacts;
  safeUserSummary?: string;
}


export interface SelectedSkuDecision {
  selectedSkuText: string | null;
  selectedPriceYuan: number | null;
  reliable: boolean;
  reason: string;
}

export interface ProductProcurementProfile {
  identity: {
    productKind: string;
    categoryType: string;
    subCategoryType: string;
    titleForReport: string;
    titleForSeo: string;
    shortTitle: string;
    coreObject: string;
    formFactor: string;
    audience: string;
    gender: string;
    season: string;
    useCases: string[];
    materials: string[];
    visibleFeatures: string[];
    claimedFeatures: string[];
    unconfirmedFeatures: string[];
  };
  sku: {
    skuSummary: string;
    selectedSkuText: string | null;
    selectedSkuReliable: boolean;
    selectedSkuDecision: SelectedSkuDecision;
    dimensions: string[];
    colors: string[];
    sizes: string[];
    models: string[];
    packageTypes: string[];
    packCounts: string[];
    skuRisk: string;
    skuWarnings: string[];
    normalizedExamples: string[];
    ambiguousParams: string[];
  };
  pricing: {
    displayPriceText: string;
    selectedPriceYuan: number | null;
    minPriceYuan: number | null;
    maxPriceYuan: number | null;
    priceSource: string;
    priceReliable: boolean;
    priceWarnings: string[];
  };
  supplier: { displayType: string; rating: string; orders: string; name: string; };
  procurement: { status: string; verdict: string; nextAction: string; mustAskSupplier: string[]; mustCheckBeforeSample: string[]; mustCheckOnSample: string[]; redFlags: string[]; };
  cargo: { mustAsk: string[]; likelySensitiveCargoIssues: string[]; };
  content: { seoAllowedClaims: string[]; seoForbiddenClaims: string[]; titleWarnings: string[]; infographicIdeas: string[]; };
  dataQuality: { missingCriticalFields: string[]; contradictions: string[]; confidence: string; reason: string; };
}

// ─── Product Intelligence ───────────────────────────────────────────────────

export interface ProductIntelligence {
  productIdentity: {
    marketNameRu: string;
    shortNameRu: string;
    productKind: string;
    categoryPath: string[];
    categoryType: string;
    subCategoryType: string;
    audience: string;
    useCases: string[];
    coreObject: string;
    formFactor: string;
    material: string[];
    powerType: string[];
    season: string;
    gender: string;
    ageGroup: string;
    importantFeatures: string[];
    notConfirmedFeatures: string[];
    visibleFeatures: string[];
    possibleConfusions: string[];
  };

  cleanTitles: {
    titleCnClean: string;
    titleRuClean: string;
    titleForReport: string;
    titleForWb: string;
  };

  wbSearch: {
    wbCoreQuery: string;
    queryCandidates: string[];
    negativeSearchTerms: string[];
    tooBroadQueries: string[];
    tooNarrowQueries: string[];
  };

  matchingRules: {
    mustHaveForDirectAnalog: string[];
    allowedDifferences: string[];
    directAnalogBlockers: string[];
    similarOnlyIf: string[];
    rejectIf: string[];
  };

  reportRules: {
    buyerMustCheck: string[];
    buyerMustNotAsk: string[];
    seoAllowedClaims: string[];
    seoForbiddenClaims: string[];
    importantAttributesToShow: string[];
    attributesToHide: string[];
    riskFlags: string[];
  };

  supplierQuestions: {
    ru: string[];
    cn: string[];
  };

  dataQuality: {
    missingCriticalFields: string[];
    skuRisk: string;
    priceRisk: string;
    weightRisk: string;
    overallConfidence: string;
    visionConfidence: string;
    textConfidence: string;
    reason: string;
  };
}

// ─── Platform Conclusion (replaces Score/Verdict) ────────────────────────────

export interface PlatformConclusion {
  platform: Platform;
  icon: string;
  headline: string;
  disclaimers: string[];
}

export interface ProductWithContent extends RawProduct1688 {
  cacheKey: string;
  titleRu: string;
  seoContent: AiContentResult;
  wbData: WbSearchResult | null;
  wbFiltered: WbFilteredResult | null;
  riskFlags: RiskFlags;
  economics: EconomicsResult;
  budgets: BudgetScenarios | null;
  maxPurchasePrice: MaxPurchasePrice | null;
  conclusion: PlatformConclusion;
  similarityData?: {
    queries: string[];
    totalAnalyzed: number;
    directCount?: number;
    similarCount?: number;
    crossBorderCount?: number;
    categoryCount?: number;
    highCount?: number;
    mediumCount?: number;
    confidence?: string;
    marketStatus?: string;
    leaders?: any[];
  };
  evidence?: FieldEvidence[];
  intelligence?: ProductIntelligence;
  productProcurementProfile?: ProductProcurementProfile;
  procurementProfile?: ProductProcurementProfile;
  productContext?: ProductContext;
  cachedAt?: Date;
}

// ─── Provider interfaces ──────────────────────────────────────────────────────

export interface ParsedUrl {
  productId: string;
  platform: Platform;
}

export interface ProductImporter {
  fetchProduct(url: string): Promise<RawProduct1688>;
  parseUrl(url: string): ParsedUrl | null;
}

// ─── WB Market Data ──────────────────────────────────────────────────────────

export type WbDataQuality = 'reliable' | 'limited' | 'unreliable' | 'unavailable';

export type MarketType = 'local_wb_market' | 'crossborder_market' | 'unknown_market';

export interface WbCard {
  title: string;
  price: number;
  url: string;
  rating: number;
  feedbacks: number;
  wh?: number | null;
  time1?: number | null;
  time2?: number | null;
  dist?: number | null;
  seller?: string;
  supplierId?: number | null;
  brand?: string;
  marketType?: MarketType;
}

export interface WbFilterKeywords {
  required: string[];
  optional: string[];
  exclude: string[];
}

export interface WbSearchResult {
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  totalCards: number;
  topExamples: WbCard[];
  allCards: WbCard[];
  photoSearchConfirmed: boolean;
}

export interface WbFilteredResult {
  quality: WbDataQuality;
  medianPrice: number;
  p25Price: number;
  p75Price: number;
  minPrice: number;
  maxPrice: number;
  relevantCount: number;
  totalCount: number;
  totalFeedbacks: number;
  avgRating: number;
  topExamples: WbCard[];
  searchQueries: string[];
  raw: WbSearchResult;
}

export interface MarketProvider {
  searchSimilar(query: string, imageUrl?: string): Promise<WbSearchResult | null>;
}

export interface AiContentRequest {
  titleCn: string;
  titleEn?: string;
  description?: string;
  priceYuan: number;
  moq: number;
  weightKg: number;
  supplierName: string;
  supplierRating?: number;
  categoryName?: string;
  attributes?: ProductAttribute[];
  confirmedFeatures?: string[];
  missingFields?: string[];
  brand?: string;
  model?: string;
  riskFlags?: RiskFlags;
  wbTopKeywords?: string[];
  platform?: Platform;
  categoryType?: string;
  intelligence?: ProductIntelligence;
  productProcurementProfile?: ProductProcurementProfile;
  procurementProfile?: ProductProcurementProfile;
  productContext?: ProductContext;
}

export interface AiContentResult {
  titleRu: string;
  titleRuBranded?: string;
  description: string;
  bullets: string[];
  keywords: string[];
  characteristics: Record<string, string>;
  filterKeywords?: WbFilterKeywords;
  searchQueries?: string[];
  warnings?: string[];
  supplierQuestions?: SupplierQuestions;
  isFallback?: boolean;
}

export interface SupplierQuestions {
  ru: string[];
  cn: string[];
}

// ─── Risk Flags ──────────────────────────────────────────────────────────────

export interface RiskFlags {
  hasBrand: boolean;
  brand?: string;
  isElectrical: boolean;
  isChildren: boolean;
  isCosmetic: boolean;
  isFood: boolean;
  isMedical: boolean;
  supplierOrdersLow: boolean;
  supplierTypeUnknown: boolean;
  weightMissing: boolean;
  sizeGridRelevant: boolean;
  marketDataUnreliable: boolean;
}

// ─── Budget Scenarios (replaces TestPurchaseResult) ──────────────────────────

export interface BudgetScenario {
  label: string;
  quantity: number;
  goodsCostRub: number;
  reserveRub: number;
  totalRub: number;
}

export interface BudgetScenarios {
  sample: BudgetScenario;
  test: BudgetScenario;
  firstBatch: BudgetScenario;
  weightMissing: boolean;
}

// ─── Max Purchase Price ──────────────────────────────────────────────────────

export interface MaxPurchasePrice {
  maxYuan: number;
  currentYuan: number;
  allowed: boolean;
  targetMarginPercent: number;
}

// ─── Field Evidence ──────────────────────────────────────────────────────────

export type FieldConfidence = 'confirmed' | 'inferred' | 'unknown';
export type FieldSource = 'product_attributes' | 'title' | 'seller' | 'llm' | 'wb';

export interface FieldEvidence {
  field: string;
  value: string | number;
  confidence: FieldConfidence;
  source: FieldSource;
}

export interface AiContentGenerator {
  generate(req: AiContentRequest): Promise<AiContentResult>;
}

// ─── ZIP ──────────────────────────────────────────────────────────────────────

export interface ZipBuilder {
  buildFromUrls(
    imageUrls: string[],
    options?: { maxImages?: number; maxSizeBytes?: number }
  ): Promise<Buffer>;
}

// ─── Subscription ─────────────────────────────────────────────────────────────

export type Plan = 'free' | 'pack10' | 'pack30' | 'week';

export interface SubscriptionStatus {
  plan: Plan;
  creditsRemaining: number;
  creditsTotal: number;
  canGenerate: boolean;
  isTrial: boolean;
  activeUntil?: Date;
}

export interface SubscriptionService {
  getStatus(userId: string): Promise<SubscriptionStatus>;
  consumeCredit(userId: string): Promise<void>;
  activate(userId: string, plan: Plan): Promise<void>;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export type EventName =
  | 'start'
  | 'sent_link'
  | 'generation_done'
  | 'generation_failed'
  | 'slow_generation'
  | 'upgrade_shown'
  | 'upgrade_clicked'
  | 'paid'
  | 'opened_zip'
  | 'last_used';

export interface AnalyticsService {
  track(userId: string, event: EventName, payload?: Record<string, unknown>): void;
}

// ─── User Settings ───────────────────────────────────────────────────────────

export interface UserTariffs {
  cargoPerKgUsd?: number;
  fulfillmentRub?: number;
  taxPercent?: number;
  targetMarginPercent?: number;
  drrPercent?: number;
}

// ─── Economics ────────────────────────────────────────────────────────────────

export type PlatformMode = 'full' | 'sample_only' | 'reference_only';

export interface EconomicsInput {
  platform: Platform;
  priceYuan: number;
  weightKg: number;
  wbAvgPrice?: number;
  wbMedianPrice?: number;
  categoryHint?: string;
  tariffs?: UserTariffs;
}

export interface EconomicsBreakdown {
  purchaseYuan: number;
  purchaseRub: number;
  bankMarkupRub: number;
  cargoRub: number;
  internalLogisticsRub: number;
  wbCommissionRub: number;
  wbLogisticsRub: number;
  taxRub: number;
  drrRub: number;
  drrPercent: number;
}

export interface EconomicsResult {
  yuanToRub: number;
  platformMode: PlatformMode;
  breakdown: EconomicsBreakdown;
  costRub: number;
  avgSaleRub: number;
  grossProfitRub: number;
  grossMarginPercent: number;
  roiPercent: number;
  weightMissing: boolean;
  weightSource?: 'product' | 'category_default' | 'user_input';
  categoryDefaultWeightKg?: number;
  isCustomTariffs: boolean;
  isSyntheticPrice: boolean;
  isEstimatedPrice?: boolean;
  disclaimer: string;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

export type Plan2 = Plan;

export interface DbUser {
  id: string;
  tg_id: number;
  created_at: string;
}

export interface DbSubscription {
  id: string;
  user_id: string;
  plan?: Plan | string;
  active_until?: string | null;
  credits_remaining?: number | null;
  is_trial?: boolean | null;
  unlimited_until?: string | null;
  unlimited_used?: number | null;
  unlimited_limit?: number | null;
  created_at: string;
  updated_at: string;
}

export interface DbProduct {
  id: string;
  user_id: string | null;
  '1688_id': string;
  cache_key: string;
  title_ru: string | null;
  price_yuan: number | null;
  weight_kg: number | null;
  data_json: Record<string, unknown>;
  created_at: string;
}

export interface DbEvent {
  id: string;
  user_id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}
