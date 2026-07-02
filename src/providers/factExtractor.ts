import { buildProductFactSheet } from '../core/factSheet';
import type { ProductFactSheet, RawProduct1688 } from '../types';

export async function extractProductFacts(raw: RawProduct1688): Promise<ProductFactSheet> {
  return buildProductFactSheet(raw);
}
