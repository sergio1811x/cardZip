// ─── CN→RU LLM translation for SKU names, colors, sizes ─────────────────────
// SKU labels on 1688/Taobao/Tmall are open-ended: colors, sizes, packs, models,
// bundles, materials, versions, voltages, localized abbreviations, seller slang.
// A fixed local dictionary gives false confidence on arbitrary goods, so this
// module uses LLM translation only and falls back to the original labels.

export interface SkuTranslationContext {
  titleCn?: string;
  titleRu?: string;
  categoryName?: string;
  attributes?: Array<{ name?: string; value?: string }>;
}

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

function compactWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanSkuLabel(value: string): string {
  return compactWhitespace(value)
    .replace(/^[-–—:：\s]+/, '')
    .replace(/[。；;]+$/g, '')
    .trim();
}

function sanitizeTranslation(input: string, output: string): string {
  const cleaned = cleanSkuLabel(output);
  if (!cleaned) return cleanSkuLabel(input);
  if (cleaned.length > 120) return cleanSkuLabel(input);
  if (/^(undefined|null|nan)$/i.test(cleaned)) return cleanSkuLabel(input);
  return cleaned;
}

function summarizeContext(context?: SkuTranslationContext): string {
  if (!context) return 'Контекст товара: не указан.';

  const attrs = (context.attributes ?? [])
    .filter((a) => a?.name || a?.value)
    .slice(0, 16)
    .map((a) => `${compactWhitespace(String(a.name ?? ''))}: ${compactWhitespace(String(a.value ?? ''))}`)
    .filter((line) => line.replace(':', '').trim())
    .join('; ');

  return [
    `Название CN: ${compactWhitespace(context.titleCn ?? '') || 'не указано'}`,
    `Название RU: ${compactWhitespace(context.titleRu ?? '') || 'не указано'}`,
    `Категория: ${compactWhitespace(context.categoryName ?? '') || 'не указана'}`,
    attrs ? `Характеристики: ${attrs}` : '',
  ].filter(Boolean).join('\n');
}

export async function translateSkuNamesViaLlm(names: string[], context?: SkuTranslationContext): Promise<string[]> {
  const inputNames = names.map((name) => String(name ?? '').trim());
  if (inputNames.length === 0) return [];
  if (!inputNames.some(hasChinese)) return inputNames.map(cleanSkuLabel);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return inputNames.map(cleanSkuLabel);

  const models = getEnvList('CARDZIP_SKU_TRANSLATOR_MODELS', DEFAULT_SKU_TRANSLATOR_MODELS);
  const prompt = [
    'Переведи SKU-варианты товара с китайского на русский для закупочного отчёта и Telegram-кнопок.',
    'Это не обычный художественный перевод. Это перевод коротких коммерческих SKU-меток произвольного товара.',
    'Сначала определи товарную нишу по контексту, потом переводи значения SKU именно в терминологии этой ниши.',
    '',
    summarizeContext(context),
    '',
    'Входные SKU:',
    JSON.stringify(inputNames),
    '',
    'Жёсткий контракт ответа:',
    '- верни только JSON-массив строк без markdown и пояснений;',
    '- количество элементов и порядок должны совпадать с входом 1:1;',
    '- не добавляй новые SKU, не объединяй и не удаляй элементы;',
    '- не добавляй свойства, которых нет во входном SKU или контексте товара;',
    '- не повторяй общее название товара в каждом SKU, если SKU и так понятен из контекста;',
    '',
    'Как переводить:',
    '- не переводи буквально, если в этой товарной нише есть короткий профессиональный термин;',
    '- сохраняй без изменений латинские/цифровые артикулы, коды моделей, серийные обозначения, объёмы, размеры, комплектации, стандарты и аббревиатуры;',
    '- если китайское слово в SKU означает тип подключения, версию, уровень, цвет, размер, комплектацию, материал или модель — передай именно эту роль коротко по-русски;',
    '- если термин может быть отраслевым обозначением, не превращай его в длинную буквальную кальку; используй принятый короткий термин для этой ниши;',
    '- если значение непонятно даже с контекстом, переведи осторожно и добавь “— уточнить”, не выдумывай смысл;',
    '- итоговая строка должна быть короткой и пригодной для кнопки Telegram, желательно до 45 символов.',
  ].join('\n');

  for (const model of models) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 1800,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: [
                'Ты профессиональный переводчик китайских SKU для закупок.',
                'Работай как товарный эксперт: сначала определяй нишу и смысл SKU, затем давай короткую русскую метку.',
                'Сохраняй артикулы, коды моделей, аббревиатуры и числовые обозначения. Не добавляй новых фактов.',
                'Ответ строго JSON-массив строк той же длины.',
              ].join(' '),
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
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

  return inputNames.map(cleanSkuLabel);
}
