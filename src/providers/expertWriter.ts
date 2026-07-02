import type { AnalysisSnapshot } from "../types";

const WRITER_MODELS = [
  "google/gemini-2.5-flash-lite",
  "deepseek/deepseek-v4-flash",
  "stepfun/step-3.7-flash",
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

const EXPERT_WRITER_PROMPT = `CardZip 2.0 Expert Writer.

Роль: закупщик и редактор закупочного пакета 1688. Улучшай данные: переводи, структурируй, помечай достоверность. Не выкидывай факты поставщика, если их можно безопасно показать как “заявлено / подтвердить”.

Источник правды: AnalysisSnapshot. Это закупочный пакет, а не обещание WB/Ozon-продаж. Авто-экономика прибыли не нужна; не выводи ROI, маржу и доходность в пользовательских текстах MVP.

Сделай результат полезным для селлера, байера, карго и контентщика.

Правила:
- не придумывай свойства, материалы, документы, вес, рынок и прибыль;
- claims: влагозащита, антискольжение, антибактериальность, безопасность, сертификаты, бренд — только “заявлено/проверить/подтвердить”;
- не советуй партию; максимум — образец, если цена/SKU понятны;
- не пиши: 0 ¥, 0 ₽, 0 кг, NaN, undefined, null, debug, raw SKU;
- SKU раскрывай как цвет × размер × модель/версия/комплектация, если это видно в данных. Не называй модель/версию “параметр SKU”.
- Если в productContext.procurementProfileDraft.domainRules есть buyerMustCheck/sampleMustCheck/cargoMustAsk/seoAllowedClaims/seoForbiddenClaims/redFlags/verdictTemplate, используй именно их как источник правил. Не смешивай с общими category tags и не превращай riskTags в риски.
- Не добавляй в текст возможности, которых нет в выбранном SKU: проводной SKU не должен получить беспроводное соединение/Bluetooth/аккумулятор; выбранный SKU не должен содержать marketing-grade слова как технический параметр.

Верни только JSON:
{
  "userCard":"короткий отчёт: товар, цена, SKU, готовность, риски, cost-only экономика, 3-5 вопросов, next step",
  "seoTitle":"продающее название для маркетплейса без неподтверждённых claims",
  "seoDescription":"2-4 предложения для карточки; без 1688 и служебных слов; спорные свойства осторожно",
  "seoBullets":["5 буллетов для карточки/инфографики"],
  "seoKeywords":["8-12 ключевых фраз"],
  "seoCharacteristics":{"параметр":"значение; при сомнении — подтвердить"},
  "buyerBrief":"ТЗ байеру: что закупаем, SKU, цена, что подтвердить, образец, фото, логистика, риски",
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
    snapshotStr.slice(0, 9000),
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
          max_tokens: Number(process.env.EXPERT_WRITER_MAX_TOKENS ?? 2800),
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
        signal: AbortSignal.timeout(60_000),
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
