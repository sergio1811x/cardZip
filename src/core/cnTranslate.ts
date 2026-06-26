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
    const prompt = `Переведи названия SKU-вариантов товара с китайского на русский. Это цвета, размеры или комбинации. Верни JSON массив строк, по одной на каждый вход. Только JSON, без markdown.\n\nВход: ${JSON.stringify(stillChinese)}`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite-preview-09-2025',
        max_tokens: 300,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return localTranslated;
    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? '';
    const cleaned = raw.replace(/```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const translated: string[] = JSON.parse(cleaned);

    if (!Array.isArray(translated) || translated.length !== stillChinese.length) return localTranslated;

    // Merge LLM translations back
    let llmIdx = 0;
    return localTranslated.map(name => {
      if (hasChinese(name) && llmIdx < translated.length) {
        return translated[llmIdx++];
      }
      return name;
    });
  } catch (e) {
    console.warn('[cnTranslate] LLM fallback failed:', (e as Error).message);
    return localTranslated;
  }
}
