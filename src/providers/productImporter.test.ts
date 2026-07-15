import { describe, expect, it } from 'vitest';
import { resolveSkuLabel } from './productImporter';

describe('resolveSkuLabel', () => {
  it('uses option values when API name is only a separator', () => {
    expect(resolveSkuLabel({
      name: ' + ',
      options: [
        { value: '落日玫瑰' },
        { value: '单嘴' },
        { value: '黑粉皮盒' },
      ],
    })).toBe('落日玫瑰 / 单嘴 / 黑粉皮盒');
  });

  it('uses option values instead of an internal SKU property code', () => {
    expect(resolveSkuLabel({
      name: '1627207:28341;1627208:992',
      options: [{ value: '黑色' }, { value: '欧规' }],
    })).toBe('黑色 / 欧规');
  });

  it('keeps a meaningful supplier name when it is available', () => {
    expect(resolveSkuLabel({
      name: '落日玫瑰单嘴+黑粉皮盒',
      options: [{ value: '黑色' }],
    })).toBe('落日玫瑰单嘴+黑粉皮盒');
  });
});
