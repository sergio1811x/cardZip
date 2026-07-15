import { z } from 'zod';
import type { ProductProcurementProfile } from '../core/procurementProfile';
import { parseLlmJson } from '../core/llmSchemas';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS = ['openai/gpt-5-mini', 'x-ai/grok-4.3', 'google/gemini-2.5-flash', 'qwen/qwen3.7-plus'];

const PackageSchema = z.object({
  supplierQuestionsRu: z.array(z.string().trim().min(8)).min(6).max(10),
  buyerBrief: z.string().trim().min(300),
  cargoBrief: z.string().trim().min(220),
  sampleChecklist: z.string().trim().min(300),
  seoText: z.string().trim().min(300),
});

const ReviewSchema = z.object({
  decision: z.enum(['PASS', 'REVISE']),
  scores: z.object({
    supplierQuestions: z.number().min(0).max(10),
    buyerBrief: z.number().min(0).max(10),
    cargoBrief: z.number().min(0).max(10),
    sampleChecklist: z.number().min(0).max(10),
    seo: z.number().min(0).max(10),
  }),
  revisionBrief: z.array(z.string().trim().min(8)).max(12).default([]),
});

export type PolishedProcurementPackage = z.infer<typeof PackageSchema>;
export type ProcurementPackageReview = {
  decision: 'PASS' | 'REVISE';
  scores: {
    supplierQuestions: number;
    buyerBrief: number;
    cargoBrief: number;
    sampleChecklist: number;
    seo: number;
  };
  revisionBrief?: string[];
};

export interface PackagePolishInput {
  profile: ProductProcurementProfile;
  baseline: {
    supplierQuestionsRu: string[];
    buyerBrief: string;
    cargoBrief: string;
    sampleChecklist: string;
    seoText: string;
  };
}

function compact(input: PackagePolishInput): string {
  const { profile, baseline } = input;
  // Keep the full editorial SEO seed in context. A blind `JSON.stringify(...).slice`
  // could cut the trailing baseline documents, including SEO, and force the writer
  // to invent structure from a partial profile.
  return JSON.stringify({
    profile: {
      identity: profile.identity,
      sku: profile.sku,
      pricing: profile.pricing,
      supplier: profile.supplier,
      procurement: profile.procurement,
      cargo: profile.cargo,
      content: profile.content,
      dataQuality: profile.dataQuality,
    },
    baseline: {
      supplierQuestionsRu: baseline.supplierQuestionsRu,
      buyerBrief: baseline.buyerBrief.slice(0, 5000),
      cargoBrief: baseline.cargoBrief.slice(0, 4000),
      sampleChecklist: baseline.sampleChecklist.slice(0, 5000),
      seoText: baseline.seoText.slice(0, 7000),
    },
  });
}

function writerPrompt(input: PackagePolishInput, revisionBrief: string[] = []): string {
  return `Ты главный редактор закупочного пакета для товара с китайской B2B-площадки.

Собери пять профессиональных документов из ЕДИНОГО профиля фактов. Не классифицируй товар по заранее заданным категориям и не используй шаблоны для типов товаров: сначала пойми объект, его конструкцию, способ применения, комплектность, риски и неизвестные данные по переданным фактам.

Жёсткая фактическая дисциплина:
- Profile — единственный источник утверждений. Если факт не подтверждён, сформулируй вопрос, проверку образца или пометку «подтвердить», а не добавляй его как свойство.
- Не добавляй сертификаты, мощность, аккумулятор, материалы, ограничения перевозки, безопасность или характеристики, которых нет в profile.
- Для SEO «похоже на обычное применение» не является доказательством. Не превращай назначение, скорость/эффект, режим, эргономику, подарок, комплектацию, хранение, питание или конструкцию в продающее утверждение, если этого нет среди явно разрешённых фактов профиля; перенеси такое в уточнение или исключи.
- Не копируй baseline механически: используй его как черновик и улучши конкретность, приоритет и полезность.
- Пиши по-русски, без китайских слов, без служебного текста, без «как указано выше».

Назначение каждого артефакта:
- supplierQuestionsRu: 8–10 коротких, независимых, приоритетных вопросов поставщику. Вопросы должны закрывать решения о SKU, комплектации, качестве, совместимости и логистике именно этого объекта; не превращай их в общий чек-лист.
- buyerBrief: Markdown с разделами Товар, Что подтвердить, Что проверить на образце, Фото, Риски, Решение. Байер должен понимать действие и причину.
- cargoBrief: Markdown для карго. Отдели известные свойства от того, что запросить. Дай только релевантные перевозочные сведения и проверяемые запросы; не выдумывай опасный груз.
- sampleChecklist: Markdown с действиями до заказа, проверкой образца, измерениями, фото, красными флагами и решением. Каждая проверка должна быть наблюдаемой или измеримой.
- seoText: Markdown с разделами Название, Описание, Буллеты, Характеристики, Ключевые слова, Что уточнить перед публикацией, Нельзя писать как факт, Идеи для инфографики. Это готовый редакционный черновик карточки, а не безопасное перечисление фактов: название — естественная поисковая фраза без тире-объяснения; описание — 3–4 разные по смыслу фразы; 3–5 буллетов раскрывают разные покупательские причины выбрать товар; ключевые слова — 10–15 самостоятельных поисковых намерений, а не повтор названия с цветами. Не повторяй один тезис между заголовком, описанием и буллетами.

Верни ТОЛЬКО JSON:
{"supplierQuestionsRu":["..."],"buyerBrief":"# ...","cargoBrief":"# ...","sampleChecklist":"# ...","seoText":"# ..."}

${revisionBrief.length ? `Исправь замечания независимого ревьюера:\n- ${revisionBrief.join('\n- ')}\n` : ''}
ДАННЫЕ:
${compact(input)}`;
}

function reviewerPrompt(input: PackagePolishInput, candidate: PolishedProcurementPackage): string {
  return `Ты независимый редактор-контролёр качества закупочных пакетов. Оцени только качество и соответствие фактам; товар заново не выдумывай.

Поставь каждому артефакту оценку 0–10. Оценка 8+ означает, что документ конкретен для данного объекта, даёт исполнителю следующие действия, не дублирует другие документы и не содержит воды. Для cargo особенно проверь практическую ценность для расчёта/перевозки; для SEO — естественное поисковое название, разные смыслы в описании и буллетах, минимум 10 самостоятельных ключевых намерений и отсутствие повторов; для чек-листа — наблюдаемость проверок.

Верни REVISE, если любой документ ниже 8 или средняя оценка ниже 8.2. В revisionBrief дай до 12 точных редакторских указаний без переписывания самого пакета. Не требуй несуществующих фактов как утверждений.

Верни ТОЛЬКО JSON:
{"decision":"PASS|REVISE","scores":{"supplierQuestions":0,"buyerBrief":0,"cargoBrief":0,"sampleChecklist":0,"seo":0},"revisionBrief":["..."]}

PROFILE:
${JSON.stringify(input.profile).slice(0, 12000)}

КАНДИДАТ:
${JSON.stringify(candidate)}`;
}

async function callJson<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const models = (process.env.PROCUREMENT_PACKAGE_MODELS ?? '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  for (const model of models.length ? models : MODELS) {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.15,
          max_tokens: 7000,
          response_format: { type: 'json_object' },
          reasoning: { enabled: false },
          messages: [
            { role: 'system', content: 'Отвечай строго одним валидным JSON-объектом без markdown.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(55_000),
      });
      if (!response.ok) continue;
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = parseLlmJson(schema, data.choices?.[0]?.message?.content ?? '');
      if (parsed) return parsed;
    } catch (error) {
      console.warn('[package-polisher]', model, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

export async function polishProcurementPackage(input: PackagePolishInput): Promise<{
  package: PolishedProcurementPackage;
  review: ProcurementPackageReview | null;
} | null> {
  let candidate = await callJson(writerPrompt(input), PackageSchema);
  if (!candidate) return null;
  let review = await callJson(reviewerPrompt(input, candidate), ReviewSchema);
  const revisionBrief = review?.revisionBrief ?? [];
  if (review?.decision === 'REVISE' && revisionBrief.length) {
    const revised = await callJson(writerPrompt(input, revisionBrief), PackageSchema);
    if (revised) {
      candidate = revised;
      review = await callJson(reviewerPrompt(input, candidate), ReviewSchema);
    }
  }
  return { package: candidate, review };
}
