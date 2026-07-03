import { describe, expect, it } from 'vitest';
import { runLegacyCanonicalizerContract } from './canonicalizerLegacyContractProvider';
import type { RawProductForCanonicalizer } from './productCanonicalizer';

function buildRaw(): RawProductForCanonicalizer {
  return {
    offerId: '1',
    titleCn: '工厂批发 PVC 充气沙发',
    titleRu: 'Надувное кресло',
    titleEn: 'inflatable chair',
  };
}

describe('legacy canonicalizer contract provider', () => {
  it('returns null without api key or successful model response', async () => {
    const result = await runLegacyCanonicalizerContract(buildRaw(), '');
    expect(result).toBeNull();
  });
});
