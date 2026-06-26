import type { RawProduct1688, Platform, ProductAttribute, ProductSku, PriceRange } from '../types';
import { translateSkuNamesViaLlm } from '../core/cnTranslate';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = '1688-datahub.p.rapidapi.com';

interface RapidApiResponse {
  result?: {
    status?: { code?: number };
    item?: {
      itemId?: string;
      title?: string;
      catId?: string;
      sales?: string;
      images?: string[];
      properties?: { list?: Array<{ name?: string; value?: string }> };
      sku?: {
        def?: { quantity?: string | number; price?: string; minOrder?: string; unit?: string };
        saleInfo?: { skuRangePrice?: Array<{ startAmount?: string; price?: string }> };
        base?: Array<{
          skuId?: string;
          propMap?: string;
          price?: string;
          promotionPrice?: string;
          quantity?: string;
          soldCount?: string;
        }>;
        props?: Array<{ name?: string; values?: Array<{ name?: string; image?: string }> }>;
      };
    };
    delivery?: { shipsFrom?: string };
    seller?: {
      sellerId?: string;
      storeTitle?: string;
      storeRating?: string;
      storeReturnBuyRate?: string;
    };
  };
}

export async function fetchFromRapidApi(productId: string): Promise<RawProduct1688 | null> {
  if (!RAPIDAPI_KEY) return null;

  try {
    const res = await fetch(`https://${RAPIDAPI_HOST}/item_detail?itemId=${productId}&locale=zh_CN&currency=CNY`, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[rapidapi] HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as RapidApiResponse;
    if (!json.result?.item?.title) return null;

    const item = json.result.item;
    const seller = json.result.seller;

    // Images
    const images = (item.images ?? [])
      .map((u) => u.startsWith('//') ? `https:${u}` : u)
      .slice(0, 15);

    // Attributes
    const attributes: ProductAttribute[] = (item.properties?.list ?? [])
      .filter((a) => a.name && a.value)
      .map((a) => ({ name: a.name!, value: a.value! }));

    // SKU — resolve propMap codes (e.g. "0:5") to human names via sku.props
    const skuBase = item.sku?.base ?? [];
    const skuProps = item.sku?.props ?? [];

    function resolveSkuName(propMap: string): string {
      // propMap format: "propIdx:valueIdx" or "propIdx:valueIdx;propIdx:valueIdx"
      const parts = propMap.split(';').map(p => p.trim()).filter(Boolean);
      const names: string[] = [];
      for (const part of parts) {
        const [pi, vi] = part.split(':').map(Number);
        const prop = skuProps[pi];
        const val = prop?.values?.[vi];
        if (val?.name) names.push(val.name);
      }
      return names.length > 0 ? names.join(' / ') : propMap;
    }

    const skusRaw: ProductSku[] = skuBase.map((s) => ({
      name: resolveSkuName(s.propMap ?? ''),
      price: s.promotionPrice ? parseFloat(s.promotionPrice) : s.price ? parseFloat(s.price) : undefined,
      stock: s.quantity ? parseInt(s.quantity) : undefined,
    })).filter((s) => s.name);

    // Translate Chinese SKU names to Russian
    const skuNames = skusRaw.map(s => s.name);
    const translatedNames = await translateSkuNamesViaLlm(skuNames);
    const skus: ProductSku[] = skusRaw.map((s, i) => ({ ...s, name: translatedNames[i] ?? s.name }));

    // Price
    const skuPrices = skus.map((s) => s.price).filter((p): p is number => p != null && p > 0).sort((a, b) => a - b);
    const defPrice = item.sku?.def?.price;
    let priceYuan = skuPrices.length ? skuPrices[Math.floor(skuPrices.length / 2)] : 0;
    if (!priceYuan && defPrice) {
      const match = defPrice.match(/([\d.]+)/);
      if (match) priceYuan = parseFloat(match[1]);
    }

    // Price ranges from skuRangePrice
    const priceRange: PriceRange[] = [];
    const rangeData = item.sku?.saleInfo?.skuRangePrice;
    if (rangeData?.length) {
      const seen = new Set<string>();
      for (const r of rangeData) {
        const key = `${r.startAmount}:${r.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        priceRange.push({
          minQty: parseInt(r.startAmount ?? '0'),
          maxQty: 0,
          price: parseFloat(r.price ?? '0'),
        });
      }
    }

    // MOQ
    const moq = item.sku?.def?.minOrder ? parseInt(item.sku.def.minOrder) : 1;

    // Stock
    const stock = item.sku?.def?.quantity
      ? (typeof item.sku.def.quantity === 'number' ? item.sku.def.quantity : parseInt(item.sku.def.quantity))
      : undefined;

    // Weight from attributes
    let weightKg = 0;
    const weightAttr = attributes.find((a) => /重量|净重|weight/i.test(a.name));
    if (weightAttr) {
      const kgMatch = weightAttr.value.match(/([\d.]+)\s*(kg|千克|公斤)/i);
      const gMatch = weightAttr.value.match(/([\d.]+)\s*(g|克)/i);
      if (kgMatch) weightKg = parseFloat(kgMatch[1]);
      else if (gMatch) weightKg = parseFloat(gMatch[1]) / 1000;
    }

    // Seller type guess from store title
    const sellerType: 'factory' | 'merchant' | 'seller' =
      seller?.storeTitle?.includes('工厂') || seller?.storeTitle?.includes('厂') ? 'factory'
      : seller?.storeTitle?.includes('实力') || seller?.storeTitle?.includes('供应商') ? 'merchant'
      : 'seller';

    console.log(`[rapidapi] Success: ${productId} | title: ${item.title?.slice(0, 30)} | skus: ${skus.length} | price: ${priceYuan}`);

    const normalized1688: any = {
      pricing: {
        quoteType: skus.length > 0 ? 'by_sku' : priceRange.length > 0 ? 'by_volume' : 'direct',
        displayPriceYuan: priceYuan,
        skuMinPriceYuan: skuPrices[0],
        skuMaxPriceYuan: skuPrices[skuPrices.length - 1],
        priceRanges: priceRange.length > 0 ? priceRange : undefined,
        rawPriceFields: [defPrice ? 'def.price' : null, skus.length ? 'sku.base' : null, rangeData?.length ? 'saleInfo' : null].filter(Boolean),
      },
      moq,
      skuCount: skus.length,
      skuVariants: skus,
      supplierType: sellerType,
      salesCount: item.sales ? parseInt(item.sales) : undefined,
      imageCount: images.length,
      images,
      weightKg: weightKg > 0 ? weightKg : undefined,
      attributes,
      keyAttributes: attributes.slice(0, 5).map((a) => ({ label: a.name, value: a.value })),
      debug: {
        provider: 'rapidapi',
        quoteType: skus.length > 0 ? 'by_sku' : 'direct',
        skuCount: skus.length,
        attributesCount: attributes.length,
        imageCount: images.length,
        sellerType,
      },
    };

    return {
      productId: String(item.itemId ?? productId),
      platform: '1688' as Platform,
      titleCn: item.title ?? '',
      priceYuan,
      priceRange: priceRange.length > 0 ? priceRange : undefined,
      priceIsRange: skuPrices.length > 1 && skuPrices[0] !== skuPrices[skuPrices.length - 1],
      moq,
      weightKg,
      images,
      mainImageUrl: images[0] ?? '',
      supplierName: seller?.storeTitle ?? '',
      supplierRating: seller?.storeRating ? parseFloat(seller.storeRating) : undefined,
      supplierType: sellerType,
      sold: item.sales ? parseInt(item.sales) : undefined,
      stock,
      categoryName: item.catId,
      attributes: attributes.length > 0 ? attributes : undefined,
      skus: skus.length > 0 ? skus : undefined,
      normalized1688,
    };
  } catch (e) {
    console.warn('[rapidapi] Error:', (e as Error).message);
    return null;
  }
}
