import type { AnalysisSnapshot } from "../types";

const WRITER_MODELS = [
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-chat-v3.2",
  "qwen/qwen3-235b-a22b",
];

function cleanJson(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
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

const EXPERT_WRITER_PROMPT = `CardZip Expert Writer — no-WB MVP.

Роль: опытный закупщик 1688 / Taobao / Tmall. Твоя задача — улучшать и структурировать данные, а не выкидывать их. Автоматический WB/Ozon-поиск НЕ является ядром продукта.

Источник правды — AnalysisSnapshot. Используй raw title/attributes/SKU, Product Intelligence, price/weight/sku/cost/readiness. Если свойство есть у поставщика, сохраняй его в безопасном статусе: “из 1688”, “заявлено поставщиком”, “подтвердить документами”, “проверить на образце”.

Жёсткие правила:
1. Не придумывай факты, но не удаляй полезные данные.
2. Не требуй WB-аналогов для полного отчёта.
3. Автоматический ROI не нужен. ROI можно упоминать только как сценарий по цене, введённой пользователем, если snapshot.economics.canShowRoi=true.
4. Не пиши “можно закупать партию”. Можно максимум “можно рассмотреть образец”, если цена/SKU понятны.
5. Claims: лечебный эффект, сертификация, безопасность, влагозащита, антибактериальность, оригинальность бренда — только как “заявлено/подтвердить”.
6. Нельзя: 0 ¥, 0 ₽, 0 кг, NaN, undefined, null, debug/raw, китайские SKU без перевода.

Верни только JSON:
{
  "userCard":"краткий насыщенный отчёт: товар, цена, SKU, свойства со статусом, готовность, cost-only экономика, вопросы, next step",
  "seoTitle":"название WB/Ozon без неподтверждённых claims",
  "seoDescription":"3-5 предложений; заявленные свойства маркируй осторожно",
  "seoBullets":["5 bullets"],
  "seoKeywords":["до 10 фраз"],
  "seoCharacteristics":{"параметр":"значение + статус"},
  "buyerBrief":"насыщенное ТЗ байеру: что закупаем, SKU, факты 1688, что подтвердить, образец, логистика, риски",
  "supplierQuestionsRu":["5-10 конкретных вопросов"],
  "supplierQuestionsCn":["5-10 вопросов на китайском"],
  "verdict":"🟢 Образец | 🟡 Нужны данные | 🔴 Высокий риск | ⛔ Не брать",
  "verdictText":"1-2 предложения",
  "readinessScore":0,
  "confidenceLevel":"high|medium|low",
  "mainRisk":"главный риск",
  "nextStep":"одно конкретное действие"
}

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

export async function runExpertWriter(
  snapshot: AnalysisSnapshot,
): Promise<ExpertWriterResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const snapshotStr = JSON.stringify(compactSnapshot(snapshot), null, 0);
  const prompt = EXPERT_WRITER_PROMPT.replace(
    "{{ANALYSIS_SNAPSHOT}}",
    snapshotStr.slice(0, 5000),
  );

  for (const model of WRITER_MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: Number(process.env.EXPERT_WRITER_MAX_TOKENS ?? 3400),
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "Ты — профессиональный товарный аналитик CardZip. Верни СТРОГО JSON, без markdown-обёрток.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        console.log(`[expert-writer] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(cleanJson(raw));
      if (parsed?.userCard) {
        console.log(
          `[expert-writer] ${model} | verdict: ${parsed.verdict} | readiness: ${parsed.readinessScore}/10`,
        );
        return {
          userCard: parsed.userCard ?? "",
          seoTitle: parsed.seoTitle ?? "",
          seoDescription: parsed.seoDescription ?? "",
          seoBullets: parsed.seoBullets ?? [],
          seoKeywords: parsed.seoKeywords ?? [],
          seoCharacteristics: parsed.seoCharacteristics ?? {},
          buyerBrief: parsed.buyerBrief ?? "",
          supplierQuestionsRu: parsed.supplierQuestionsRu ?? [],
          supplierQuestionsCn: parsed.supplierQuestionsCn ?? [],
          verdict: parsed.verdict ?? "❓",
          verdictText: parsed.verdictText ?? "",
          readinessScore: parsed.readinessScore ?? 0,
          confidenceLevel: parsed.confidenceLevel ?? "🔴",
          mainRisk: parsed.mainRisk ?? "",
          nextStep: parsed.nextStep ?? "",
        };
      }
    } catch (err) {
      console.log(
        `[expert-writer] ${model} error: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
  }
  return null;
}
