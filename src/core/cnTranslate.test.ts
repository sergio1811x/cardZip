import { describe, expect, it } from 'vitest';
import { keepUsableSkuTranslations } from './cnTranslate';

describe('SKU translation safety', () => {
  it('keeps the supplier label when an LLM returns only a separator', () => {
    expect(keepUsableSkuTranslations(['落日玫瑰单嘴+黑粉皮盒'], ['+']))
      .toEqual(['落日玫瑰单嘴+黑粉皮盒']);
  });

  it('does not accept a translation that drops a compound SKU component', () => {
    expect(keepUsableSkuTranslations(['黑色+欧规'], ['чёрный']))
      .toEqual(['黑色+欧规']);
  });

  it('keeps a complete human-readable translation', () => {
    expect(keepUsableSkuTranslations(['黑色+欧规'], ['чёрный · EU']))
      .toEqual(['чёрный · EU']);
  });

  it('separates adjacent colour values produced by dictionary substitution', () => {
    expect(keepUsableSkuTranslations(['蓝红'], ['синийкрасный']))
      .toEqual(['синий · красный']);
  });
});
