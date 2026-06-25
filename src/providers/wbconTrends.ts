export interface WbTrend {
  search_words: string;
  weeks_request_per_day: number;
  month_request_per_day: number;
  rank: number;
  products: number;
  coef: number;
}

export interface WbTrendsResult {
  query: string;
  trends: WbTrend[];
  latencyMs: number;
}

const WBCON_TRENDS_URL = 'https://wbcon.ru/wp-json/wb-services/v1/extended/get_wb_trends_by_query';

export async function fetchWbTrends(query: string): Promise<WbTrendsResult> {
  const start = Date.now();
  try {
    const res = await fetch(WBCON_TRENDS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, offset: 0, limit: 50 }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.log(`[wbcon-trends] ${query} → HTTP ${res.status}`);
      return { query, trends: [], latencyMs: Date.now() - start };
    }

    const data = await res.json() as any;
    const trends: WbTrend[] = (data?.trends ?? []).map((t: any) => ({
      search_words: t.search_words ?? '',
      weeks_request_per_day: t.weeks_request_per_day ?? 0,
      month_request_per_day: t.month_request_per_day ?? 0,
      rank: t.rank ?? 0,
      products: t.products ?? 0,
      coef: t.coef ?? 0,
    }));

    console.log(`[wbcon-trends] ${query} → ${trends.length} trends, ${Date.now() - start}ms`);
    return { query, trends, latencyMs: Date.now() - start };
  } catch (e: any) {
    console.log(`[wbcon-trends] ${query} → error: ${e.message}, ${Date.now() - start}ms`);
    return { query, trends: [], latencyMs: Date.now() - start };
  }
}

export function filterRelevantTrends(
  trends: WbTrend[],
  coreQuery: string,
  productType: string,
  materials: string[],
): WbTrend[] {
  const excludePatterns = [
    /медицинск/i, /ортопедическ/i, /профессиональн/i,
  ];

  const coreLower = coreQuery.toLowerCase();
  const typeLower = productType.toLowerCase();
  const materialSet = new Set(materials.map((m) => m.toLowerCase()));

  return trends
    .filter((t) => {
      const w = t.search_words.toLowerCase();

      if (!w.includes(coreLower.split(' ')[0])) return false;

      if (excludePatterns.some((p) => p.test(w))) return false;

      const conflictMaterials = ['кожаные', 'кожа', 'замшевые', 'замша', 'текстильные', 'деревянные', 'металлические'];
      for (const cm of conflictMaterials) {
        if (w.includes(cm) && !materialSet.has(cm) && !typeLower.includes(cm)) return false;
      }

      return true;
    })
    .sort((a, b) => b.weeks_request_per_day - a.weeks_request_per_day)
    .slice(0, 10);
}
