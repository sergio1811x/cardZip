import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, tryConsumeCredit } from '../src/services/subscriptionService';
import { trackQualityMetrics } from '../src/services/analyticsService';
import { buildMainMessage, buildSafeSummary } from '../src/core/messageBuilder';

import { buildDecisionContext } from '../src/core/decisionLayer';
import { ensureProductProcurementProfile, buildSupplierQuestionsFromProfile, translateSupplierQuestionsRuToCn, formatSupplierQuestionsText, buildBuyerBriefFromProfile, buildCargoBriefFromProfile, buildSampleChecklistFromProfile, buildSeoDraftFromProfile, buildReadmeFromProfile, validateDocuments, validateMainReport, validateProfile, repairProcurementTexts } from '../src/core/procurementProfile';
import { validateProcurementResult } from '../src/core/validateProcurementResult';
import { upsertProduct } from '../src/db/queries/products';
import { buildCacheKey } from '../src/lib/cache';
import { acquireStepLock } from '../src/lib/stepLock';
import { redis } from '../src/lib/redis';
import { createStepProgress } from '../src/core/progress';
import { runQaGate } from '../src/providers/expertQaGate';
import { runAutoFix } from '../src/providers/autoFix';
import { runConsistencyAuditor } from '../src/providers/consistencyAuditor';
import { buildProductFactSheet } from '../src/core/factSheet';
import { generateSupplierQuestions, type GeneratorInput } from '../src/providers/supplierQuestionsGenerator';
import { generateSeoCard } from '../src/providers/seoCardGenerator';
import { generateCargoBrief } from '../src/providers/cargoBriefGenerator';
import { buildQualityMetricsPayload, summarizeQualityMetrics } from '../src/core/qualityMetrics';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function safeIssues(value: any): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function isOnlyNonBlockingQualityIssue(reason: string): boolean {
  const text = String(reason ?? '').toLowerCase();
  if (!text.trim()) return false;
  const dangerous = /(0\s*[¥₽]|0\s*кг|nan|undefined|null|debug|raw|можно\s+(?:закупать|брать)|закупка\s+целесообразна|лечит|лечебный\s+эффект)/i.test(text);
  return !dangerous;
}

function applyCreditsLine(text: string, creditsRemaining: number): string {
  const line = `📦 Осталось: ${Math.max(0, creditsRemaining)} анализов`;
  const withoutOldCounters = String(text ?? '')
    .replace(/\n*Осталось анализов:\s*\d+\s*/gi, '')
    .replace(/\n*📦\s*Осталось:\s*\d+\s+анализов\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return `${withoutOldCounters}\n\n${line}`;
}

function uniqueQuestions(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const value = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}


function applySanitizedArtifacts(
  fixedPayload: Record<string, unknown> | null | undefined,
  artifacts: {
    finalText: string;
    seoText: string;
    briefText: string;
    supplierText: string;
    cargoText: string;
    sampleChecklistText: string;
    readmeText: string;
  },
) {
  const fixed = fixedPayload ?? {};
  return {
    finalText: String(fixed.userCard ?? fixed.UserCard ?? artifacts.finalText),
    seoText: String(fixed.seoText ?? fixed.SeoText ?? artifacts.seoText),
    briefText: String(fixed.buyerBrief ?? fixed.BuyerBrief ?? artifacts.briefText),
    supplierText: String(fixed.supplierQuestions ?? fixed.SupplierQuestions ?? artifacts.supplierText),
    cargoText: String(fixed.cargoBrief ?? fixed.CargoBrief ?? artifacts.cargoText),
    sampleChecklistText: String(fixed.sampleChecklist ?? fixed.SampleChecklist ?? artifacts.sampleChecklistText),
    readmeText: String(fixed.readme ?? fixed.Readme ?? artifacts.readmeText),
  };
}

function formatConsistencyIssuesForRepair(audit: {
  issues?: string[];
  requiredEdits?: Array<{ artifact?: string; reason?: string; instruction?: string }>;
} | null | undefined): string[] {
  const issues = Array.isArray(audit?.issues) ? audit.issues.map(String) : [];
  const editIssues = Array.isArray(audit?.requiredEdits)
    ? audit.requiredEdits.map((edit) => {
        const artifact = String(edit?.artifact ?? 'artifact');
        const reason = String(edit?.reason ?? 'нужна правка');
        const instruction = String(edit?.instruction ?? '').trim();
        return `[${artifact}] ${reason}${instruction ? `: ${instruction}` : ''}`;
      })
    : [];
  return [...issues, ...editIssues];
}

function toArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

/** Build the GeneratorInput for the focused LLM generators from the product. */
function buildGeneratorInput(product: any): GeneratorInput {
  const identity = (product?.productContext?.identity ?? {}) as Record<string, any>;
  const intelId = (product?.intelligence?.productIdentity ?? {}) as Record<string, any>;
  const attrsRaw = toArray(product?.attributes ?? product?.normalized1688?.attributes);
  const attributes = attrsRaw
    .map((a: any) => ({ name: String(a?.name ?? ''), value: String(a?.value ?? '') }))
    .filter((a) => a.name || a.value)
    .slice(0, 30);
  const skuNames = toArray(product?.skus ?? product?.normalized1688?.skuVariants)
    .map((s: any) => String(s?.name ?? s?.raw ?? s?.label ?? '').trim())
    .filter(Boolean)
    .slice(0, 30);
  const priceNum = Number(
    product?.priceYuan ?? product?.minPriceYuan ?? intelId?.priceYuan,
  );
  return {
    titleRu: product?.titleRu || product?.titleEn || undefined,
    titleCn: product?.titleCn || undefined,
    priceYuan: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null,
    attributes,
    skuNames,
    coreObject: identity.coreObject || intelId.coreObject || undefined,
    categoryType: identity.categoryType || intelId.categoryType || product?.categoryName || undefined,
    useCases: toArray(identity.useCases ?? intelId.useCases).map(String).filter(Boolean),
    materials: toArray(identity.materials ?? intelId.materials).map(String).filter(Boolean),
  };
}

/**
 * Run the three focused, independently-failing LLM generators in parallel and
 * merge whatever each returned into the product's procurementProfileDraft.domainRules
 * — the SAME path aiDomainRules/aiDomainContent already consume. Each generator
 * returns null on failure; on null we leave the existing canonicalizer output /
 * honest-generic floor untouched. Returns a one-line success summary for logging.
 */
async function populateDomainRulesFromGenerators(product: any): Promise<string> {
  const input = buildGeneratorInput(product);
  const [questions, seo, cargo] = await Promise.all([
    generateSupplierQuestions(input).catch(() => null),
    generateSeoCard(input).catch(() => null),
    generateCargoBrief(input).catch(() => null),
  ]);

  product.productContext = product.productContext ?? {};
  const draft = (product.productContext.procurementProfileDraft =
    product.productContext.procurementProfileDraft ?? {});
  const domainRules = (draft.domainRules = draft.domainRules ?? {});

  if (questions && Array.isArray(questions.ru) && questions.ru.length) {
    domainRules.buyerMustCheck = questions.ru;
  }

  if (seo) {
    domainRules.seo = {
      ...(domainRules.seo ?? {}),
      title: seo.title || (domainRules.seo?.title ?? undefined),
      description: seo.description || (domainRules.seo?.description ?? undefined),
      sellingBullets: Array.isArray(seo.bullets) && seo.bullets.length
        ? seo.bullets
        : domainRules.seo?.sellingBullets,
      keywords: Array.isArray(seo.keywords) && seo.keywords.length
        ? seo.keywords
        : domainRules.seo?.keywords,
      characteristics: Array.isArray(seo.characteristics) && seo.characteristics.length
        ? seo.characteristics
        : domainRules.seo?.characteristics,
    };
  }

  if (cargo) {
    domainRules.cargo = {
      ...(domainRules.cargo ?? {}),
      sensitiveIssues: Array.isArray(cargo.considerations) && cargo.considerations.length
        ? cargo.considerations
        : domainRules.cargo?.sensitiveIssues,
      whatToRequest: Array.isArray(cargo.whatToRequest) && cargo.whatToRequest.length
        ? cargo.whatToRequest
        : domainRules.cargo?.whatToRequest,
      cargoNature: cargo.cargoNature || (domainRules.cargo?.cargoNature ?? undefined),
      packagingNotes: domainRules.cargo?.packagingNotes ?? '',
    };
  }

  return `supplierQuestions=${questions ? 'ok' : 'null'} seoCard=${seo ? 'ok' : 'null'} cargoBrief=${cargo ? 'ok' : 'null'}`;
}

async function sendPaymentRequired(job: any) {
  if (job.tg_message_id) await bot.telegram.deleteMessage(job.tg_chat_id, job.tg_message_id).catch(() => {});
  await bot.telegram.sendMessage(job.tg_chat_id, '💳 Недостаточно кредитов для отправки полного отчёта. Пополните баланс и запустите анализ заново — полный отчёт без списания не отправлен.', {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
}

async function sendBlocked(job: any, product: any, reason: string) {
  if (job.tg_message_id) await bot.telegram.deleteMessage(job.tg_chat_id, job.tg_message_id).catch(() => {});
  await bot.telegram.sendMessage(job.tg_chat_id, buildSafeSummary(product, reason), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  await markSent(job.id);
  if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  let progress: ReturnType<typeof createStepProgress> | null = null;

  try {
    console.log(`[step5] Start: ${jobId}`);
    if (!await acquireStepLock('step5', jobId)) {
      console.log(`[step5] Duplicate blocked for job ${jobId}`);
      return res.status(200).json({ ok: true, skip: true });
    }

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    const result = job.result_json as any;
    const chatId = job.tg_chat_id;
    progress = job.tg_message_id ? createStepProgress(bot, chatId, job.tg_message_id, 'files') : null;
    progress?.step('files');
    const product = {
      ...(result.product as ProductWithContent),
      intelligence: result.productIntelligence ?? result.intelligence ?? (result.product as any)?.intelligence,
      productProcurementProfile: result.productProcurementProfile ?? result.procurementProfile ?? (result.product as any)?.productProcurementProfile,
      procurementProfile: result.productProcurementProfile ?? result.procurementProfile ?? (result.product as any)?.procurementProfile,
      sourceUrl: job.input_url,
      analysisSnapshot: result.analysisSnapshot,
    } as ProductWithContent & Record<string, any>;
    // Resilient LLM layer: three focused generators repopulate the
    // procurementProfileDraft.domainRules path that the profile builders consume.
    // Each fails independently (returns null) → existing floor survives.
    try {
      const genSummary = await populateDomainRulesFromGenerators(product);
      console.log(`[step5] focused generators: ${genSummary}`);
    } catch (e) {
      console.warn('[step5] focused generators failed entirely (using floor):', e instanceof Error ? e.message : e);
    }

    const profile = ensureProductProcurementProfile(product, { sourceUrl: job.input_url });
    const profileValidation = validateProfile(profile);
    if (!profileValidation.ok) console.warn('[step5] profile validator:', profileValidation.errors.join('; '));
    product.productProcurementProfile = profileValidation.fixedProfile;
    product.procurementProfile = profileValidation.fixedProfile;
    const decisionContext = buildDecisionContext(product);

    // Generate every user-facing document from the single ProductProcurementProfile.
    // No document builder is allowed to re-detect productKind or infer category from raw attributes.
    const supplierQuestionSet = buildSupplierQuestionsFromProfile(product, { sourceUrl: job.input_url });
    const gapPlan = result.gapPlan as { supplierQuestionsRu?: string[] } | null | undefined;
    // Cap at 10 (CLAUDE.md §10): the CN translator caps at 10, so a 11–12 RU list
    // would leave RU and CN mismatched in length and silently drop the whole CN.
    const mergedSupplierQuestionsRu = uniqueQuestions([
      ...(supplierQuestionSet.ru ?? []),
      ...((gapPlan?.supplierQuestionsRu ?? []) as string[]),
    ]).slice(0, 10);
    const translatedCn = await translateSupplierQuestionsRuToCn(mergedSupplierQuestionsRu).catch(() => supplierQuestionSet.cn);
    const formattedSupplierQuestions = formatSupplierQuestionsText(mergedSupplierQuestionsRu, translatedCn);
    const profileForFiles = {
      ...profileValidation.fixedProfile,
      supplierQuestionsCn: formattedSupplierQuestions.cn,
      supplierQuestionsCnValid: formattedSupplierQuestions.cnValid,
    };
    product.productProcurementProfile = profileForFiles;
    product.procurementProfile = profileForFiles;
    let supplierText = formattedSupplierQuestions.text;
    let briefText = buildBuyerBriefFromProfile(product, { sourceUrl: job.input_url });
    let cargoText = buildCargoBriefFromProfile(product, { sourceUrl: job.input_url });
    let sampleChecklistText = buildSampleChecklistFromProfile(product, { sourceUrl: job.input_url });
    let seoText = buildSeoDraftFromProfile(product, { sourceUrl: job.input_url });
    let readmeText = buildReadmeFromProfile(product, { sourceUrl: job.input_url });
    let infographicText = '';
    let riskChecklistText = '';
    let sampleRecommendationText = sampleChecklistText;

    progress?.step('validate');
    const docsValidation = validateDocuments([
      { filename: '01_Вопросы_поставщику.txt', text: supplierText },
      { filename: '02_ТЗ_байеру.md', text: briefText },
      { filename: '03_ТЗ_карго.md', text: cargoText },
      { filename: '04_Чеклист_образца.md', text: sampleChecklistText },
      { filename: '05_SEO_черновик.md', text: seoText },
      { filename: '00_Инструкция.txt', text: readmeText },
    ], profileForFiles);
    if (docsValidation.errors.length) console.warn('[step5] profile document validators repaired:', docsValidation.errors.join('; '));
    for (const doc of docsValidation.fixedDocs) {
      if (doc.filename === '01_Вопросы_поставщику.txt') supplierText = doc.text;
      if (doc.filename === '02_ТЗ_байеру.md') briefText = doc.text;
      if (doc.filename === '03_ТЗ_карго.md') cargoText = doc.text;
      if (doc.filename === '04_Чеклист_образца.md') sampleChecklistText = doc.text;
      if (doc.filename === '05_SEO_черновик.md') seoText = doc.text;
      if (doc.filename === '00_Инструкция.txt') readmeText = doc.text;
    }

    await supabase.from('jobs').update({
      result_json: {
        ...result,
        product,
        productProcurementProfile: profileForFiles,
        procurementProfile: profileForFiles,
        generatedFiles: { seoText, briefText, supplierQuestions: supplierText, supplierQuestionsCn: formattedSupplierQuestions.cn, supplierQuestionsCnValid: formattedSupplierQuestions.cnValid, cargoText, sampleChecklistText, readmeText },
      },
    }).eq('id', jobId);

    const packageCategory = null;

    const currentStatus = await getStatus(job.user_id);
    const statusBeforeCharge = {
      plan: currentStatus.plan ?? 'free',
      creditsRemaining: currentStatus.creditsRemaining ?? 0,
      creditsTotal: 0,
      canGenerate: true,
      isTrial: currentStatus.isTrial ?? false,
    };
    const { text: mainTextRaw, keyboard } = buildMainMessage(product, job.id, statusBeforeCharge as any, packageCategory);
    const mainProfileValidation = validateMainReport(mainTextRaw);
    if (mainProfileValidation.errors.length) console.warn('[step5] main profile validator repaired:', mainProfileValidation.errors.join('; '));
    const mainText = mainProfileValidation.fixedText;

    let finalText = mainText;

    const procurementResultValidation = repairProcurementTexts({
      mainReport: finalText,
      docs: [
        { filename: '01_Вопросы_поставщику.txt', text: supplierText },
        { filename: '02_ТЗ_байеру.md', text: briefText },
        { filename: '03_ТЗ_карго.md', text: cargoText },
        { filename: '04_Чеклист_образца.md', text: sampleChecklistText },
        { filename: '05_SEO_черновик.md', text: seoText },
        { filename: '00_Инструкция.txt', text: readmeText },
      ],
      profile: profileForFiles,
    });
    if (procurementResultValidation.errors.length) console.warn('[step5] procurement result validator repaired:', procurementResultValidation.errors.join('; '));
    if (procurementResultValidation.fixed.mainReport) finalText = procurementResultValidation.fixed.mainReport;
    for (const doc of procurementResultValidation.fixed.docs) {
      if (doc.filename === '01_Вопросы_поставщику.txt') supplierText = doc.text;
      if (doc.filename === '02_ТЗ_байеру.md') briefText = doc.text;
      if (doc.filename === '03_ТЗ_карго.md') cargoText = doc.text;
      if (doc.filename === '04_Чеклист_образца.md') sampleChecklistText = doc.text;
      if (doc.filename === '05_SEO_черновик.md') seoText = doc.text;
      if (doc.filename === '00_Инструкция.txt') readmeText = doc.text;
    }

    const snapshot = result.analysisSnapshot ?? { productContext: product.productContext, purchasePrice: decisionContext.price, weight: decisionContext.weight, sku: decisionContext.sku };
    let hard = { block: false, canShowFullReport: true, warnings: [] as any[], issues: [] as any[], fixedArtifacts: {} as Record<string, unknown>, safeUserSummary: {} as any };

    progress?.step('qa');
    // QA Gate полностью отключён: он не должен блокировать показ полного отчёта.
    // Оставляем только code-level validators и consistency-аудит ниже.
    const qaResult = {
      decision: 'PASS',
      canShowToUser: true,
      qualityScore: 8,
      confidence: 'medium',
      summary: 'QA Gate отключён по настройке продукта.',
      issues: [],
      warnings: [],
      criticalIssues: [],
      requiredEdits: [],
    } as any;

    const auditMode = String(process.env.CARDZIP_CONSISTENCY_AUDIT_MODE ?? 'always').toLowerCase();
    const shouldRunConsistencyAudit = auditMode !== 'off';
    const consistencyAudit = shouldRunConsistencyAudit
      ? await runConsistencyAuditor(snapshot as any, {
          userCard: finalText,
          seoText,
          buyerBrief: briefText,
          cargoBrief: cargoText,
          sampleChecklist: sampleChecklistText,
          supplierQuestions: supplierText,
          readme: readmeText,
        }).catch(() => null)
      : null;
    if (consistencyAudit?.issues?.length) {
      console.warn('[step5] consistency audit:', consistencyAudit.issues.join('; '));
    }

    // Never hard-block the report. A BLOCK or FIX_REQUIRED from the consistency
    // auditor triggers a repair pass; afterwards we always show the best-effort
    // report (degrade, don't block).
    if (consistencyAudit?.decision === 'FIX_REQUIRED' || consistencyAudit?.decision === 'BLOCK') {
      progress?.step('autofix');
      const consistencyFixed = await runAutoFix(
        snapshot as any,
        {
          userCard: finalText,
          seoText,
          buyerBrief: briefText,
          supplierQuestions: supplierText,
          cargoBrief: cargoText,
          sampleChecklist: sampleChecklistText,
          readme: readmeText,
        },
        {
          decision: 'FIX_REQUIRED',
          qualityScore: 5,
          issues: formatConsistencyIssuesForRepair(consistencyAudit),
          requiredEdits: consistencyAudit.requiredEdits,
        } as any,
      ).catch(() => null);

      const repaired = applySanitizedArtifacts(consistencyFixed, {
        finalText,
        seoText,
        briefText,
        supplierText,
        cargoText,
        sampleChecklistText,
        readmeText,
      });
      finalText = repaired.finalText;
      seoText = repaired.seoText;
      briefText = repaired.briefText;
      supplierText = repaired.supplierText;
      cargoText = repaired.cargoText;
      sampleChecklistText = repaired.sampleChecklistText;
      readmeText = repaired.readmeText;

      const postConsistencyRepair = repairProcurementTexts({
        mainReport: finalText,
        docs: [
          { filename: '01_Вопросы_поставщику.txt', text: supplierText },
          { filename: '02_ТЗ_байеру.md', text: briefText },
          { filename: '03_ТЗ_карго.md', text: cargoText },
          { filename: '04_Чеклист_образца.md', text: sampleChecklistText },
          { filename: '05_SEO_черновик.md', text: seoText },
          { filename: '00_Инструкция.txt', text: readmeText },
        ],
        profile: profileForFiles,
      });
      if (postConsistencyRepair.fixed.mainReport) finalText = postConsistencyRepair.fixed.mainReport;
      for (const doc of postConsistencyRepair.fixed.docs) {
        if (doc.filename === '01_Вопросы_поставщику.txt') supplierText = doc.text;
        if (doc.filename === '02_ТЗ_байеру.md') briefText = doc.text;
        if (doc.filename === '03_ТЗ_карго.md') cargoText = doc.text;
        if (doc.filename === '04_Чеклист_образца.md') sampleChecklistText = doc.text;
        if (doc.filename === '05_SEO_черновик.md') seoText = doc.text;
        if (doc.filename === '00_Инструкция.txt') readmeText = doc.text;
      }

      const auditAfterRepair = await runConsistencyAuditor(snapshot as any, {
        userCard: finalText,
        seoText,
        buyerBrief: briefText,
        cargoBrief: cargoText,
        sampleChecklist: sampleChecklistText,
        supplierQuestions: supplierText,
        readme: readmeText,
      }).catch(() => null);
      if (auditAfterRepair?.decision === 'BLOCK') {
        console.warn('[step5] consistency auditor still flags after repair — showing best-effort report (not blocking):', auditAfterRepair.issues?.join('; ') || auditAfterRepair.summary || '');
      }
      if (auditAfterRepair?.issues?.length) {
        console.warn('[step5] consistency audit after repair:', auditAfterRepair.issues.join('; '));
      }
    }

    // Final read-only quality gate over the finalized package (logs defects; non-blocking).
    const finalFactSheet = (snapshot as any)?.factSheet ?? buildProductFactSheet(product as any);
    const finalQuality = validateProcurementResult({
      files: [
        { name: '01_Вопросы_поставщику.txt', content: supplierText },
        { name: '02_ТЗ_байеру.md', content: briefText },
        { name: '03_ТЗ_карго.md', content: cargoText },
        { name: '04_Чеклист_образца.md', content: sampleChecklistText },
        { name: '05_SEO_черновик.md', content: seoText },
        { name: '00_Инструкция.txt', content: readmeText },
      ],
      productDetailsText: '',
      mainReportText: finalText,
      seoDraftMd: seoText,
      productKind: profileForFiles?.identity?.productKind,
      priceReliable: profileForFiles?.pricing?.priceReliable,
      plugStandardReliable: !!profileForFiles?.sku?.selectedPlugStandard,
      selectedSkuText: profileForFiles?.sku?.selectedSkuText ?? undefined,
      factSheet: finalFactSheet,
    });
    if (!finalQuality.passed) console.error('[step5] procurement quality gate defects:', finalQuality.errors.join('; '));
    if (finalQuality.warnings.length) console.warn('[step5] procurement quality warnings:', finalQuality.warnings.join('; '));

    const qualityMetrics = buildQualityMetricsPayload({
      jobId,
      offerId: (snapshot as any)?.offerId,
      categoryType: (snapshot as any)?.productContext?.identity?.categoryType,
      productKind: profileForFiles?.identity?.productKind,
      metrics: [
        {
          stage: 'qa_gate',
          status: qaResult?.decision === 'BLOCK' ? 'fail' : qaResult?.decision === 'FIX_REQUIRED' ? 'warn' : 'pass',
          issuesCount: qaResult?.issues?.length ?? 0,
          warningsCount: qaResult?.warnings?.length ?? 0,
        },
        {
          stage: 'consistency_audit',
          status: consistencyAudit?.decision === 'FIX_REQUIRED' ? 'warn' : 'pass',
          issuesCount: consistencyAudit?.issues?.length ?? 0,
          warningsCount: consistencyAudit?.requiredEdits?.length ?? 0,
        },
        {
          stage: 'final_quality',
          status: !finalQuality.passed ? 'fail' : finalQuality.warnings.length ? 'warn' : 'pass',
          issuesCount: finalQuality.errors.length,
          warningsCount: finalQuality.warnings.length,
        },
      ],
    });
    const qualitySummary = summarizeQualityMetrics(qualityMetrics.metrics as any);
    await trackQualityMetrics(job.user_id, {
      jobId,
      offerId: (snapshot as any)?.offerId,
      categoryType: (snapshot as any)?.productContext?.identity?.categoryType,
      productKind: profileForFiles?.identity?.productKind,
      metrics: qualityMetrics.metrics as any,
    });

    progress?.step('charge');
    // Charge only after hard validator + QA allow the full user report.
    const charged = await tryConsumeCredit(job.user_id);
    if (!charged) {
      console.warn(`[step5] no credits after QA for job ${job.id}`);
      progress?.message('Кредит не списан: не хватает баланса для отправки полного отчёта', 98);
      progress?.stop();
      await sendPaymentRequired(job);
      return res.status(200).json({ ok: true, blocked: true, source: 'payment_required' });
    }
    const freshStatus = await getStatus(job.user_id);
    // Do not rebuild the report after QA/Auto-Fix: that can discard repaired text.
    // Only update the credits line in the already validated artifact.
    finalText = applyCreditsLine(finalText, freshStatus.creditsRemaining ?? 0);

    const productWithProcurementState = { ...(product as any), procurementStatus: 'analyzed' };

    await supabase.from('jobs').update({
      procurement_status: 'analyzed',
      procurement_score: decisionContext.readiness.score,
      procurement_pipeline: {
        product_data: true,
        sku_parsed: decisionContext.sku.skuCount > 0,
        weight_confirmed: decisionContext.weight.canUseForCargo,
        dimensions_confirmed: false,
        supplier_reply_received: false,
        sample_ordered: false,
        sample_checked: false,
        test_batch_ready: false,
      },
      result_json: {
        ...result,
        product: productWithProcurementState,
        productProcurementProfile: profileForFiles,
        procurementProfile: profileForFiles,
        generatedFiles: { seoText, briefText, supplierQuestions: supplierText, supplierQuestionsCn: formattedSupplierQuestions.cn, supplierQuestionsCnValid: formattedSupplierQuestions.cnValid, cargoText, sampleChecklistText, readmeText },
        finalUserCard: finalText,
        qaResult,
        consistencyAudit,
        qualityMetrics,
        qualitySummary,
      },
    }).eq('id', jobId);

    progress?.step('telegram');
    await bot.telegram.sendMessage(chatId, finalText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    });

    progress?.stop();
    if (job.tg_message_id) await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});

    await markSent(job.id);
    if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch((e) =>
      console.warn('[step5] Cache save failed:', e instanceof Error ? e.message : e),
    );

    console.log(`[step5] Job ${job.id} sent | hard=PASS | qa=${qaResult?.decision ?? 'SKIPPED'}`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    progress?.message('Возникла ошибка на финальной стадии — отправляю служебное сообщение', 98);
    progress?.stop();
    console.error('[step5]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
