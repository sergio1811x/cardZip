import { getCategoryRules, type ProductCategoryType } from './categoryRules';
import type { ProductIntelligence } from '../types';

interface ValidationResult {
  ok: boolean;
  errors: string[];
  fixedText: string;
}

const CHINESE_PATTERN = /[一-鿿]/;
const RAW_CN_VALUES = ['现货', '加厚', '注塑鞋', '包头拖', '出口', '整单', '库存类型', '货源类别'];

export function validateReport(
  text: string,
  categoryType: ProductCategoryType,
  context: {
    hasPrice: boolean;
    hasWeight: boolean;
    hasDirectAnalogs: boolean;
    wb429: boolean;
    intelligence?: ProductIntelligence | null;
  }
): ValidationResult {
  const errors: string[] = [];
  const rules = getCategoryRules(categoryType);
  let fixed = text;

  // 1. No debug fields
  if (/debug|quote_type|rawPriceFields|extraInfoKeys/i.test(fixed)) {
    errors.push('debug fields found');
    fixed = fixed.replace(/^.*(?:debug|quote_type|rawPriceFields|extraInfoKeys).*$/gm, '');
  }

  // 2. No 0 ¥ or 0 ₽
  if (/\b0\s*[¥₽]/.test(fixed) && !context.hasPrice) {
    errors.push('0 ¥/₽ shown without price');
    fixed = fixed.replace(/\b0\s*¥/g, 'нужно уточнить');
    fixed = fixed.replace(/\b0\s*₽/g, 'нужно уточнить');
  }

  // 3. No Chinese characters in user-facing text
  if (CHINESE_PATTERN.test(fixed)) {
    errors.push('Chinese characters found');
    // Remove lines with untranslated Chinese
    fixed = fixed.split('\n').filter(line => !CHINESE_PATTERN.test(line)).join('\n');
  }

  // 4. No raw CN values
  for (const raw of RAW_CN_VALUES) {
    if (fixed.includes(raw)) {
      errors.push(`raw CN value: ${raw}`);
      fixed = fixed.replace(new RegExp(raw, 'g'), '');
    }
  }

  // 5. No forbidden category terms
  for (const forbidden of rules.forbiddenFields) {
    const pattern = new RegExp(forbidden, 'gi');
    if (pattern.test(fixed)) {
      errors.push(`forbidden term for ${categoryType}: ${forbidden}`);
      fixed = fixed.replace(pattern, '');
    }
  }

  // 6. ROI without direct analogs
  if (!context.hasDirectAnalogs && /ROI\s*[:=]\s*\d/.test(fixed)) {
    errors.push('ROI calculated without direct analogs');
  }

  // 7. WB 429 not mentioned
  if (context.wb429 && !fixed.includes('ограничил') && !fixed.includes('429')) {
    errors.push('WB 429 not mentioned');
  }

  // 8. Intelligence-based forbidden content
  if (context.intelligence?.reportRules?.buyerMustNotAsk) {
    for (const forbidden of context.intelligence.reportRules.buyerMustNotAsk) {
      if (fixed.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`intelligence forbidden: ${forbidden}`);
      }
    }
  }
  if (context.intelligence?.reportRules?.seoForbiddenClaims) {
    for (const forbidden of context.intelligence.reportRules.seoForbiddenClaims) {
      if (fixed.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`intelligence seo forbidden claim: ${forbidden}`);
      }
    }
  }

  // Clean up empty lines
  fixed = fixed.replace(/\n{3,}/g, '\n\n').trim();

  return {
    ok: errors.length === 0,
    errors,
    fixedText: fixed,
  };
}

export function validateSeoContent(
  seo: { title?: string; titleRu?: string; description?: string; bullets?: string[]; characteristics?: Record<string, string> },
  categoryType: ProductCategoryType,
  intelligence?: ProductIntelligence | null,
): { ok: boolean; errors: string[]; fixed: typeof seo } {
  const errors: string[] = [];
  const rules = getCategoryRules(categoryType);
  const fixed = { ...seo };

  const checkText = (text: string, field: string): string => {
    if (CHINESE_PATTERN.test(text)) {
      errors.push(`Chinese in SEO ${field}`);
    }
    for (const raw of RAW_CN_VALUES) {
      if (text.includes(raw)) {
        errors.push(`raw CN in SEO ${field}: ${raw}`);
        text = text.replace(new RegExp(raw, 'g'), '');
      }
    }
    for (const forbidden of rules.forbiddenFields) {
      if (text.toLowerCase().includes(forbidden.toLowerCase())) {
        errors.push(`forbidden in SEO ${field}: ${forbidden}`);
      }
    }
    // Intelligence-based forbidden claims
    if (intelligence?.reportRules?.seoForbiddenClaims) {
      for (const forbidden of intelligence.reportRules.seoForbiddenClaims) {
        if (text.toLowerCase().includes(forbidden.toLowerCase())) {
          errors.push(`intelligence seo forbidden in ${field}: ${forbidden}`);
        }
      }
    }
    return text;
  };

  if (fixed.title) fixed.title = checkText(fixed.title, 'title');
  if (fixed.titleRu) fixed.titleRu = checkText(fixed.titleRu, 'titleRu');
  if (fixed.description) fixed.description = checkText(fixed.description, 'description');
  if (fixed.bullets) {
    fixed.bullets = fixed.bullets
      .map((b, i) => checkText(b, `bullet[${i}]`))
      .filter(b => !CHINESE_PATTERN.test(b));
  }
  if (fixed.characteristics) {
    const cleanChars: Record<string, string> = {};
    for (const [k, v] of Object.entries(fixed.characteristics)) {
      if (CHINESE_PATTERN.test(k) || CHINESE_PATTERN.test(v)) {
        errors.push(`Chinese in characteristics: ${k}`);
        continue;
      }
      const kLower = k.toLowerCase();
      if (rules.forbiddenFields.some(f => kLower.includes(f.toLowerCase()))) {
        errors.push(`forbidden characteristic: ${k}`);
        continue;
      }
      // Intelligence: hide specific attributes
      if (intelligence?.reportRules?.attributesToHide?.some(
        (h) => kLower.includes(h.toLowerCase())
      )) {
        errors.push(`intelligence hidden characteristic: ${k}`);
        continue;
      }
      cleanChars[k] = v;
    }
    fixed.characteristics = cleanChars;
  }

  return { ok: errors.length === 0, errors, fixed };
}
