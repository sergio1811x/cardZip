// ─── CN→RU translation for SKU names, colors, sizes ────────────────────────

const CN_COLORS: Record<string, string> = {
  '黑色': 'чёрный', '白色': 'белый', '红色': 'красный', '蓝色': 'синий',
  '绿色': 'зелёный', '黄色': 'жёлтый', '粉色': 'розовый', '紫色': 'фиолетовый',
  '灰色': 'серый', '棕色': 'коричневый', '橙色': 'оранжевый', '米色': 'бежевый',
  '卡其色': 'хаки', '驼色': 'верблюжий', '藏青色': 'тёмно-синий', '酒红色': 'бордовый',
  '咖啡色': 'кофейный', '杏色': 'абрикосовый', '深蓝': 'тёмно-синий',
  '浅蓝': 'голубой', '深灰': 'тёмно-серый', '浅灰': 'светло-серый',
  '黑': 'чёрный', '白': 'белый', '红': 'красный', '蓝': 'синий',
  '绿': 'зелёный', '粉': 'розовый', '灰': 'серый', '黄': 'жёлтый',
  '紫': 'фиолетовый', '橙': 'оранжевый', '棕': 'коричневый',
  '红绿': 'красно-зелёный', '红蓝': 'красно-синий', '红绿蓝': 'красно-зелёно-синий',
  '透明': 'прозрачный', '银色': 'серебристый', '金色': 'золотистый',
  '天蓝': 'небесно-голубой', '玫红': 'фуксия', '军绿': 'хаки',
  '花色': 'цветной', '迷彩': 'камуфляж', '条纹': 'полосатый',
  '彩色': 'разноцветный', '混色': 'микс',
};

const CN_SIZES: Record<string, string> = {
  '均码': 'one size', '大码': 'XL+', '小码': 'S',
  '加大': 'XXL', '特大': 'XXXL',
};

export function translateSkuName(cn: string): string {
  if (!cn) return cn;
  // Direct match
  if (CN_COLORS[cn]) return CN_COLORS[cn];
  if (CN_SIZES[cn]) return CN_SIZES[cn];

  // Composite: try translating each part separated by /
  let result = cn;
  for (const [key, val] of Object.entries(CN_COLORS)) {
    if (result.includes(key)) result = result.replace(key, val);
  }
  for (const [key, val] of Object.entries(CN_SIZES)) {
    if (result.includes(key)) result = result.replace(key, val);
  }
  return result;
}

export function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
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

export async function translateSkuNamesViaLlm(names: string[]): Promise<string[]> {
  const chineseNames = names.filter(hasChinese);
  if (chineseNames.length === 0) return names;

  // First try local dictionary
  const localTranslated = names.map(translateSkuName);
  const stillChinese = localTranslated.filter(hasChinese);
  if (stillChinese.length === 0) return localTranslated;

  // LLM fallback for remaining Chinese names
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return localTranslated;

  try {
    const prompt = `Ты переводчик SKU-вариантов товаров с 1688 (CN→RU). Это цвета, размеры, модели, комплектации или их комбинации.
Правила:
- переводи смысл цвета/размера на русский;
- артикулы, коды моделей и стандарты НЕ искажай: 美规→US, 欧规→EU, 英规→UK, 日规→JP, 韩规→KR, 澳规→AU, 国标→CN;
- сохраняй числа и единицы (10kg, 5L, 300ml) как есть;
- ровно один перевод на каждый вход, тот же порядок.
Верни только JSON-массив строк, без markdown.

Вход: ${JSON.stringify(stillChinese)}`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        max_tokens: 300,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return localTranslated;
    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? '';
    const translated = tryParseStringArray(raw);

    if (!translated || translated.length !== stillChinese.length) return localTranslated;

    // Merge LLM translations back
    let llmIdx = 0;
    return localTranslated.map(name => {
      if (hasChinese(name) && llmIdx < translated.length) {
        return translated[llmIdx++];
      }
      return name;
    });
  } catch (e) {
    console.log('[cnTranslate] LLM fallback skipped:', (e as Error).message);
    return localTranslated;
  }
}

// ─── RU→CN faithful translation of supplier questions ──────────────────────
//
// Translates the ACTUAL supplier questions for THIS product 1:1 into
// professional procurement Chinese. No fixed phrasebook, no substituted or
// product-mismatched content. Returns a CN array the same length as the input,
// or an empty array on any failure (caller decides RU-only fallback).

function hasCyrillic(text: string): boolean {
  return /[а-яё]/i.test(text);
}

/**
 * Faithfully translate a list of Russian supplier questions to Chinese.
 * - 1:1 count and order with the input.
 * - Preserves steel grades, model codes, units and numbers verbatim.
 * - No added, dropped or product-mismatched content; no meta lines.
 * Returns [] if translation cannot be produced reliably (caller falls back to RU-only).
 */
export async function translateQuestionsToCn(ruQuestions: string[]): Promise<string[]> {
  const questions = (ruQuestions ?? [])
    .map((q) => String(q ?? '').trim())
    .filter(Boolean);
  if (questions.length === 0) return [];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return [];

  const prompt = `Ты профессиональный переводчик закупочных сообщений RU→CN для чата с поставщиком на 1688/Taobao/Tmall.
Тебе дают массив вопросов поставщику на русском ИМЕННО про конкретный товар. Переведи их на деловой закупочный китайский.

Строгие правила:
- Переводи РОВНО эти вопросы, ничего не добавляй и не выбрасывай. Никакого фиксированного шаблона и никаких вопросов «из другого товара».
- Ровно один китайский перевод на каждый вход, тот же порядок, длина массива = длине входа (${questions.length}).
- Сохраняй без искажений: марки/сорта стали (например 9Cr18MoV, HRC 58), коды моделей, артикулы, числа и единицы (10kg, 5L, 300ml, HRC).
- Стандарты питания: US→美规, EU→欧规, UK→英规, JP→日规, KR→韩规, AU→澳规, CN→国标.
- Профессиональный, вежливый закупочный тон. Никаких мета-фраз вроде «уточните информацию из этого вопроса», никаких пояснений, никакой нумерации внутри строки.
- Не подставляй содержание, которого нет в русском вопросе (нельзя превратить вопрос про нож в вопрос про сушилку для посуды).
- Если вопрос трудно перевести уверенно — переведи его буквально по смыслу, но НЕ заменяй на несвязанный текст.
- Десятичный разделитель — точка (12.5), не запятая.

Верни ТОЛЬКО JSON-массив строк на китайском, без markdown, без пояснений.

Вход: ${JSON.stringify(questions)}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        max_tokens: 1600,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) return [];
    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? '';
    const translated = tryParseStringArray(raw);

    if (!translated || translated.length !== questions.length) return [];

    const out = translated.map((s) => String(s ?? '').trim());
    // Faithfulness guards: every line must be non-empty, contain Chinese,
    // and carry no leftover Cyrillic (that would signal a broken / partial translation).
    if (out.some((s) => !s || !hasChinese(s) || hasCyrillic(s))) return [];

    return out;
  } catch (e) {
    console.log('[cnTranslate] RU→CN translation skipped:', (e as Error).message);
    return [];
  }
}
