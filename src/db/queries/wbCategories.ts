import { supabase } from '../supabase';

export interface WbCategory {
  category: string;
  item: string;
  sellers: number;
  sellers_with_orders: number;
  product_cards: number;
  product_cards_with_orders: number;
  revenue_rub: number;
  average_check_rub: number;
  average_rating: number;
  stock_quantity: number;
  redemption_rate: number;
  monopolization_percentage: number;
  turnover_days_per_week: number;
  availability: string;
  parse_date: string;
}

export async function upsertWbCategories(rows: WbCategory[]): Promise<number> {
  const BATCH = 500;
  let total = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('wb_categories')
      .upsert(batch.map((r) => ({
        ...r,
        updated_at: new Date().toISOString(),
      })), { onConflict: 'item,parse_date' });

    if (error) console.error('[wbCategories] upsert error:', error.message);
    else total += batch.length;
  }

  return total;
}

export async function findWbCategory(query: string): Promise<WbCategory | null> {
  const q = query.toLowerCase().trim();

  const { data } = await supabase
    .from('wb_categories')
    .select('*')
    .ilike('item', `%${q}%`)
    .order('parse_date', { ascending: false })
    .order('revenue_rub', { ascending: false })
    .limit(1);

  return (data?.[0] as WbCategory) ?? null;
}

export async function findWbCategoriesByKeywords(keywords: string[]): Promise<WbCategory[]> {
  const results: WbCategory[] = [];
  const seen = new Set<string>();

  for (const kw of keywords.slice(0, 5)) {
    const { data } = await supabase
      .from('wb_categories')
      .select('*')
      .ilike('item', `%${kw}%`)
      .order('parse_date', { ascending: false })
      .order('revenue_rub', { ascending: false })
      .limit(3);

    for (const row of (data ?? []) as WbCategory[]) {
      if (!seen.has(row.item)) {
        seen.add(row.item);
        results.push(row);
      }
    }
  }

  return results.slice(0, 5);
}
