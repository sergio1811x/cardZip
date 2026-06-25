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
  selectedSkuPriceYuan?: number;
  priceRanges?: PriceRange[];
  rawPriceFields: string[];
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
  isCustomTariffs: boolean;
  isSyntheticPrice: boolean;
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
  plan: Plan;
  active_until: string | null;
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
