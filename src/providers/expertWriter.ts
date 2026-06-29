import type { AnalysisSnapshot } from '../types';

const WRITER_MODELS = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat-v3.2',
  'qwen/qwen3-235b-a22b',
];

function cleanJson(raw: string): string {
  return raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
}

export interface ExpertWriterResult {
  userCard?: string;
  seoTitle?: string;
  seoDescription?: string;
  seoBullets?: string[];
  seoKeywords?: string[];
  seoCharacteristics?: Record<string, string>;
  buyerBrief?: string;
  supplierQuestionsRu?: string[];
  supplierQuestionsCn?: string[];
  verdict: string;
  verdictText: string;
  readinessScore: number;
  confidenceLevel: string;
  mainRisk: string;
  nextStep: string;
}

const EXPERT_WRITER_PROMPT = `CardZip Expert Writer v4 compact.

Роль: закупочный аналитик 1688 → WB/Ozon. Пиши коротко, практично и безопасно. Источник правды — только AnalysisSnapshot.

Жёсткие правила:
1. Не придумывай факты, материалы, документы, качество, размеры, влагозащиту, безопасность, бренды, медицинские/детские/пищевые свойства.
2. ROI/маржу/цену продажи выводи только если s.economics.canShowRoi=true и s.market.canUseForEconomics=true.
3. Broad category, WBCON и cross-border — не рынок для экономики.
4. Не пиши “можно закупать/брать”, если не подтверждены выбранный SKU, цена, вес с упаковкой и прямой локальный рынок.
5. Если claim не подтверждён в allowedClaims/facts/raw attributes, формулируй как “уточнить/подтвердить у поставщика”.
6. В блоках “нельзя писать” используй категории риска, а не буквальные рекламные claims: “влагозащита без подтверждения”, “сертификация без документов”, “обещания безопасности/качества без подтверждения”.
7. Запрещены пользовательские токены: 0 ¥, 0 ₽, 0 кг, NaN, undefined, null, raw/debug, китайские raw-атрибуты без перевода.

Верни только JSON:
{
  "userCard":"короткий отчёт до 2200 знаков: товар, данные 1688, WB рынок, экономика, вопросы, вердикт, next step",
  "seoTitle":"название WB без неподтверждённых claims",
  "seoDescription":"2-4 предложения, только подтверждённое или осторожное",
  "seoBullets":["5 коротких bullets"],
  "seoKeywords":["до 10 поисковых фраз"],
  "seoCharacteristics":{"параметр":"значение/уточнить"},
  "buyerBrief":"ТЗ байеру до 2500 знаков: что закупаем, что подтвердить, логистика, бюджет/риски",
  "supplierQuestionsRu":["5-8 конкретных вопросов"],
  "supplierQuestionsCn":["5-8 вопросов на китайском"],
  "verdict":"✅ Можно тестировать | 🟡 Проверять дальше | 🔴 Только образец | ⛔ Не брать | ❓ Недостаточно данных",
  "verdictText":"1-2 предложения",
  "readinessScore":0,
  "confidenceLevel":"high|medium|low",
  "mainRisk":"главный риск",
  "nextStep":"одно конкретное действие"
}

Decision rules:
- reliable/full only when SKU + price + packed weight + 5+ direct local analogs are confirmed.
- if data is incomplete, verdict is “Проверять дальше”, “Только образец” or “Недостаточно данных”.
- supplier questions must not ask already-known facts; ask missing critical data.

DATA:
{{ANALYSIS_SNAPSHOT}}
`;

function compactSnapshot(snapshot: AnalysisSnapshot): Record<string, unknown> {
  const s = snapshot as any;
  return {
    offerId: s.offerId,
    raw1688: {
      titleCn: s.raw1688?.titleCn,
      photosCount: s.raw1688?.photosCount,
      attributesRaw: s.raw1688?.attributesRaw,
    },
    productContext: s.productContext,
    supplier: s.supplier,
    purchasePrice: s.purchasePrice,
    weight: s.weight,
    sku: { ...s.sku, variants: s.sku?.variants?.slice?.(0, 12) ?? [] },
    market: {
      directAnalogsCount: s.market?.directAnalogsCount,
      similarAnalogsCount: s.market?.similarAnalogsCount,
      broadCategoryCount: s.market?.broadCategoryCount,
      crossBorderCount: s.market?.crossBorderCount,
      marketConfirmed: s.market?.marketConfirmed,
      displayedMainPriceRub: s.market?.displayedMainPriceRub,
      canUseForEconomics: s.market?.canUseForEconomics,
      rejectedReason: s.market?.rejectedReason,
      directAnalogs: s.market?.directAnalogs?.slice?.(0, 5) ?? [],
    },
    economics: s.economics,
    missingData: s.missingData,
    conflicts: s.conflicts,
    riskFlags: s.riskFlags,
  };
}

export async function runExpertWriter(snapshot: AnalysisSnapshot): Promise<ExpertWriterResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const snapshotStr = JSON.stringify(compactSnapshot(snapshot), null, 0);
  const prompt = EXPERT_WRITER_PROMPT.replace('{{ANALYSIS_SNAPSHOT}}', snapshotStr.slice(0, 5000));

  for (const model of WRITER_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 2600,
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Ты — профессиональный товарный аналитик CardZip. Верни СТРОГО JSON, без markdown-обёрток.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.log(`[expert-writer] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed?.userCard) {
        console.log(`[expert-writer] ${model} | verdict: ${parsed.verdict} | readiness: ${parsed.readinessScore}/10`);
        return {
          userCard: parsed.userCard ?? '',
          seoTitle: parsed.seoTitle ?? '',
          seoDescription: parsed.seoDescription ?? '',
          seoBullets: parsed.seoBullets ?? [],
          seoKeywords: parsed.seoKeywords ?? [],
          seoCharacteristics: parsed.seoCharacteristics ?? {},
          buyerBrief: parsed.buyerBrief ?? '',
          supplierQuestionsRu: parsed.supplierQuestionsRu ?? [],
          supplierQuestionsCn: parsed.supplierQuestionsCn ?? [],
          verdict: parsed.verdict ?? '❓',
          verdictText: parsed.verdictText ?? '',
          readinessScore: parsed.readinessScore ?? 0,
          confidenceLevel: parsed.confidenceLevel ?? '🔴',
          mainRisk: parsed.mainRisk ?? '',
          nextStep: parsed.nextStep ?? '',
        };
      }
    } catch (err) {
      console.log(`[expert-writer] ${model} error: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }
  return null;
}
