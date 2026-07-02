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

export async function fetchWbTrends(query: string): Promise<WbTrendsResult> {
  return { query, trends: [], latencyMs: 0 };
}

export function filterRelevantTrends(trends: WbTrend[]): WbTrend[] {
  return trends;
}
