// ─── CN→RU LLM translation for SKU names, colors, sizes ─────────────────────
// SKU labels on 1688/Taobao/Tmall are open-ended: colors, sizes, packs, models,
// bundles, materials, versions, voltages, localized abbreviations, seller slang.
// A fixed local dictionary gives false confidence on arbitrary goods, so this
// module uses LLM translation only and falls back to the original labels.

export function translateSkuName(cn: string): string {
  return String(cn ?? '').trim();
}

export function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

const DEFAULT_SKU_TRANSLATOR_MODELS = [
  'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-v4-flash',
  'stepfun/step-3.7-flash',
];

function getEnvList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function tryParseStringArray(raw: string): string[] | null {
  const cleaned = String(raw ?? '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  const candidates = [cleaned];
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
    } catch {}
  }
  return null;
}

function sanitizeTranslation(input: string, output: string): string {
  const cleaned = String(output ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—:：\s]+/, '')
    .trim();
  if (!cleaned) return input;
  if (cleaned.length > 120) return input;
  if (/^(undefined|null|nan)$/i.test(cleaned)) return input;
  return cleaned;
}

export async function translateSkuNamesViaLlm(names: string[]): Promise<string[]> {
  const inputNames = names.map((name) => String(name ?? '').trim());
  if (inputNames.length === 0) return [];
  if (!inputNames.some(hasChinese)) return inputNames;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return inputNames;

  const models = getEnvList('CARDZIP_SKU_TRANSLATOR_MODELS', DEFAULT_SKU_TRANSLATOR_MODELS);
  const prompt = [
    'Переведи SKU-варианты товара с китайского на русский для закупочного отчёта.',
    'Это могут быть цвета, размеры, комплектации, модели, наборы, количество штук, версии, напряжение или seller-specific параметры.',
    'Требования:',
    '- верни СТРОГО JSON-массив строк без markdown;',
    '- количество элементов и порядок должны совпадать с входом 1:1;',
    '- не добавляй новые SKU, не объединяй и не удаляй элементы;',
    '- коды моделей, цифры, размеры, артикулы, A/B/C, 2шт/3шт сохраняй;',
    '- если значение непонятно, переведи буквально и добавь “— значение уточнить”, но не выдумывай смысл;',
    '- не пиши маркетинговые свойства, которых нет во входе.',
    `Вход: ${JSON.stringify(inputNames)}`,
  ].join('\n');

  for (const model of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          temperature: 0,
          messages: [
            { role: 'system', content: 'Ты переводчик SKU CN→RU. Верни только JSON-массив строк той же длины.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(12_000),
      });

      if (!res.ok) {
        console.log(`[cnTranslate] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? '';
      const translated = tryParseStringArray(raw);
      if (!translated || translated.length !== inputNames.length) continue;

      return translated.map((value, index) => sanitizeTranslation(inputNames[index] ?? '', value));
    } catch (e) {
      console.log(`[cnTranslate] ${model} skipped:`, (e as Error).message);
      continue;
    }
  }

  return inputNames;
}
