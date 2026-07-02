import { z } from 'zod';

export const ExpertWriterResultSchema = z.object({
  userCard: z.string().trim().min(10),
  seoTitle: z.string().trim().min(5).optional().default(''),
  seoDescription: z.string().trim().min(10).optional().default(''),
  seoBullets: z.array(z.string().trim().min(3)).max(5).optional().default([]),
  seoKeywords: z.array(z.string().trim().min(2)).max(20).optional().default([]),
  seoCharacteristics: z.record(z.string()).optional().default({}),
  buyerBrief: z.string().trim().optional().default(''),
  supplierQuestionsRu: z.array(z.string().trim().min(3)).max(10).optional().default([]),
  supplierQuestionsCn: z.array(z.string().trim().min(1)).max(10).optional().default([]),
  verdict: z.string().trim().optional().default('❓'),
  verdictText: z.string().trim().min(3).optional().default(''),
  readinessScore: z.number().min(0).max(10).optional().default(0),
  confidenceLevel: z.string().trim().optional().default('🔴'),
  mainRisk: z.string().trim().optional().default(''),
  nextStep: z.string().trim().optional().default(''),
});

export const QaGateResultSchema = z.object({
  decision: z.enum(['PASS', 'FIX_REQUIRED', 'BLOCK']),
  canShowToUser: z.boolean().optional().default(true),
  qualityScore: z.number().min(0).max(100).optional().default(0),
  confidence: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  summary: z.string().optional().default(''),
  issues: z.array(z.string()).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
  criticalIssues: z.array(z.string()).optional().default([]),
  requiredEdits: z.array(z.record(z.unknown())).optional().default([]),
});

export const AutoFixResultSchema = z.object({
  fixed: z.boolean().optional().default(false),
  summary: z.string().optional().default(''),
  userCard: z.string().optional(),
  seoText: z.string().optional(),
  buyerBrief: z.string().optional(),
  supplierQuestions: z.string().optional(),
  cargoBrief: z.string().optional(),
  sampleChecklist: z.string().optional(),
  readme: z.string().optional(),
  remainingRisks: z.array(z.string()).optional().default([]),
  needsSecondQa: z.boolean().optional().default(false),
}).passthrough();

export const GapPlannerResultSchema = z.object({
  missingFacts: z.array(z.string().trim().min(1)).optional().default([]),
  supplierQuestionsRu: z.array(z.string().trim().min(3)).max(12).optional().default([]),
  requiredConfirmations: z.array(z.string().trim().min(1)).optional().default([]),
  warnings: z.array(z.string().trim().min(1)).optional().default([]),
});

export const ConsistencyAuditResultSchema = z.object({
  decision: z.enum(['PASS', 'FIX_REQUIRED', 'BLOCK']),
  summary: z.string().trim().optional().default(''),
  issues: z.array(z.string().trim().min(1)).optional().default([]),
  requiredEdits: z.array(z.object({
    artifact: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    instruction: z.string().trim().min(1),
  })).optional().default([]),
});

export function parseLlmJson<T>(schema: z.ZodSchema<T>, raw: string): T | null {
  const cleaned = String(raw ?? '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return schema.parse(parsed);
  } catch {
    return null;
  }
}
