import type { MarketProvider, WbSearchResult } from '../types';

async function searchSimilar(_query: string, _imageUrl?: string): Promise<WbSearchResult | null> {
  return null;
}

export const marketProvider: MarketProvider = { searchSimilar };
