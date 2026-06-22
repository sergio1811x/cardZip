import { supabase } from '../supabase';
import type { DbProduct, ProductWithContent } from '../../types';

export async function findProductByKey(cacheKey: string): Promise<DbProduct | null> {
  const { data } = await supabase
    .from('products')
    .select('*')
    .eq('cache_key', cacheKey)
    .single();
  return (data as DbProduct) ?? null;
}

export async function findLastProductByUser(userId: string): Promise<DbProduct | null> {
  const { data } = await supabase
    .from('products')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return (data as DbProduct) ?? null;
}

export async function upsertProduct(
  userId: string,
  product: ProductWithContent
): Promise<void> {
  await supabase.from('products').upsert(
    {
      user_id: userId,
      '1688_id': product.productId,
      cache_key: product.cacheKey,
      title_ru: product.titleRu,
      price_yuan: product.priceYuan,
      weight_kg: product.weightKg,
      data_json: {
        raw: product,
        seoContent: product.seoContent,
        wbData: product.wbData,
        economics: product.economics,
      },
    },
    { onConflict: 'cache_key' }
  );
}
