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
}

export type Verdict = {
  signal: 'green' | 'yellow' | 'red';
  label: string;
  reasons: string[];
};

export interface ProductWithContent extends RawProduct1688 {
  cacheKey: string;
  titleRu: string;
  seoContent: AiContentResult;
  wbData: WbSearchResult | null;
  economics: EconomicsResult;
  verdict: Verdict;
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

export interface WbSearchResult {
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  totalCards: number;
  topExamples: Array<{ title: string; price: number; url: string }>;
}

export interface MarketProvider {
  searchSimilar(query: string): Promise<WbSearchResult | null>;
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
}

export interface AiContentResult {
  titleRu: string;
  description: string;
  bullets: string[];
  keywords: string[];
  characteristics: Record<string, string>;
  isFallback?: boolean;
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

export type Plan = 'free' | 'seller' | 'business';

export interface SubscriptionStatus {
  plan: Plan;
  isActive: boolean;
  generationsUsed: number;
  generationsLimit: number;
  canGenerate: boolean;
  activeUntil?: Date;
}

export interface SubscriptionService {
  getStatus(userId: string): Promise<SubscriptionStatus>;
  consumeGeneration(userId: string): Promise<void>;
  activate(userId: string, plan: Plan, months: number): Promise<void>;
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

// ─── Economics ────────────────────────────────────────────────────────────────

export interface EconomicsInput {
  priceYuan: number;
  weightKg: number;
  wbAvgPrice?: number;
}

export interface EconomicsResult {
  yuanToRub: number;
  costRub: number;
  avgSaleRub: number;
  grossProfitRub: number;
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
