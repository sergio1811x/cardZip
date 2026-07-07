import type { AnalysisSnapshot } from '../core/analysisSnapshot';
import { ExpertWriterResultSchema, parseLlmJson } from '../core/llmSchemas';

const WRITER_MODELS = [
  "qwen/qwen3.6-flash",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v4-flash",
];

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

const EXPERT_WRITER_PROMPT = `CardZip Expert Writer.

Роль: writer пользовательских артефактов закупочного пакета 1688. Ты не extractor и не classifier. Не определяй товар заново. Пиши только по canonical facts.

Источник правды: analysisSnapshot.factSheet, analysisSnapshot.categoryPolicy, analysisSnapshot.productContext, analysisSnapshot.supplier, analysisSnapshot.purchasePrice, analysisSnapshot.weight, analysisSnapshot.sku.

Если факт имеет статус unknown, supplier_pending или conflict — не превращай его в утверждение. Пиши только как «нужно подтвердить у поставщика».

Если есть conflict по полю, не выбирай значение сам. Укажи, что есть противоречие и его нужно снять у поставщика.

CardZip — закупочный пакет по ссылке. Не пиши оценку продаж или финансовый прогноз.

Задача: сделать тексты понятными для селлера, байера, карго и контентщика.

Правила:
- не придумывай свойства, материалы, документы, вес, цену или комплектацию;
- спорные claims пиши только как “заявлено, нужно подтвердить”;
- не советуй партию, если не подтверждены SKU, вес, упаковка и образец;
- максимум следующий шаг: запросить данные / заказать 1–2 образца;
- не пиши: 0 ¥, 0 ₽, 0 кг, NaN, undefined, null, debug, raw, Product Intelligence, cross-border;
- не добавляй свойства, которых нет в выбранном SKU;
- проводной SKU не должен получить Bluetooth, аккумулятор или беспроводное подключение;
- UPF50+, антибактериальность, сертификация, безопасность, влагозащита, ортопедичность — только как неподтверждённые claims;
- вопросы поставщику бери только из profile.procurement.mustAskSupplier, можно только улучшить формулировку и убрать дубли;
- НИКОГДА не выдумывай числовые параметры (состав в %, напряжение, объём, размеры, вес, сертификаты). Если параметра нет в исходных данных — спрашивай обобщённо: «Подтвердите состав ткани.», а не «90% нейлон, 10% спандекс». Число указывай, только если оно дословно есть в исходных данных;
- каждый вопрос — отдельная тема, без повторов и парафраза одной просьбы дважды («Предоставьте размерную сетку» и «Пришлите размерную сетку» — это дубль);
- грамотный русский: правильные падежи после предлогов («для йоги, фитнеса, бега», а не «для йога, фитнес, бег»); перечисление внутри фразы через двоеточие или скобки («размерную сетку (обхват талии, бёдер, длина по каждому размеру)»); буква ё где нужно (бёдер);
- не начинай описание с голого существительного-обрывка («шорты.»); пиши полное предложение;
- буллеты — законченные грамотные фразы, не обрывки-слаги;
- китайский текст не генерируй: его делает отдельный RU→CN translator.

Верни строго JSON без markdown:
{
  "userCard":"короткий пользовательский отчёт без лишней воды",
  "seoTitle":"продающее название без неподтверждённых claims",
  "seoDescription":"2-4 предложения для карточки товара без 1688 и служебных слов",
  "seoBullets":["ровно 5 буллетов"],
  "seoKeywords":["8-12 ключевых фраз"],
  "seoCharacteristics":{"параметр":"значение; если не подтверждено — подтвердить"},
  "buyerBrief":"ТЗ байеру: товар, SKU, цена, что подтвердить, образец, фото, риски",
  "supplierQuestionsRu":["5-10 вопросов без дублей"],
  "verdictText":"1-2 предложения под конкретный productKind",
  "mainRisk":"главный риск закупки",
  "nextStep":"одно конкретное действие"
}

Требования к качеству:
- userCard должен читаться за 30-60 секунд.
- seoTitle не должен содержать “черновик”, “1688”, “заявлено”, “подтвердить”.
- seoBullets — ровно 5 пунктов.
- supplierQuestionsRu — максимум 10 вопросов.
- verdictText должен быть конкретным под товар, не универсальным шаблоном.
- если данных мало, честно пиши “нужно подтвердить у поставщика”.

DATA:
{{PRODUCT_PROFILE_PACKAGE}}
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
    factSheet: s.factSheet,
    categoryPolicy: s.categoryPolicy,
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
    "{{PRODUCT_PROFILE_PACKAGE}}",
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
          max_tokens: Number(process.env.EXPERT_WRITER_MAX_TOKENS ?? 6500),
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
        signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) {
        console.log(`[expert-writer] ${model} HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = parseLlmJson(ExpertWriterResultSchema, raw);
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
