import { buildCategoryPolicyProfile } from '../core/categoryPolicyRegistry';
import type { CategoryPolicyProfile, RawProduct1688 } from '../types';

export async function classifyProductCapabilities(raw: RawProduct1688): Promise<CategoryPolicyProfile> {
  return buildCategoryPolicyProfile({
    categoryType: raw.categoryName ?? 'other',
    title: `${raw.titleCn ?? ''} ${raw.titleEn ?? ''}`,
    attributes: raw.attributes ?? raw.normalized1688?.attributes ?? [],
  });
}
