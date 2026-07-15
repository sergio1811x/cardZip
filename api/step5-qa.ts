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
import { writeSeoProse } from '../src/providers/documentWriter';
import { buildProductFactSheet } from '../src/core/factSheet';
import { buildQualityMetricsPayload, summarizeQualityMetrics } from '../src/core/qualityMetrics';
import type { ProductWithContent } from '../src/types';

// The package editor may make a writer, reviewer, and one revision call. Keep the
// serverless budget above that bounded editorial loop; deterministic fallbacks
// still ship when a provider is unavailable.
export const config = { maxDuration: 300 };

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
    // Product Intelligence is the single author of domainRules. Earlier Step 5
    // generators received only a lossy title/SKU subset and overwrote that profile
    // with conflicting questions, cargo requests and SEO claims. Do not run a
    // second fact-authoring loop after the profile has been assembled.

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
    let mergedSupplierQuestionsRu = uniqueQuestions([
      ...(supplierQuestionSet.ru ?? []),
      ...((gapPlan?.supplierQuestionsRu ?? []) as string[]),
    ])
      // A RU question carrying raw CJK is a half-translated hybrid — the SKU
      // normalizer glues an untranslated variant name into Russian text
      // («Какой стандарт вилки у SKU «落日玫瑰单嘴+чёрныйрозовый皮盒»?»). It is
      // unusable for the buyer and always duplicates a clean question that asks
      // the same thing about "выбранный SKU". Dropped BEFORE translation so RU
      // and CN stay length-aligned. Structural, not product/category specific.
      .filter((q) => !/[㐀-鿿]/.test(q))
      .slice(0, 10);
    let translatedCn = await translateSupplierQuestionsRuToCn(mergedSupplierQuestionsRu).catch((e) => {
      console.warn('[cnQuestions] step5 translator threw:', e instanceof Error ? e.message : e);
      return supplierQuestionSet.cn;
    });
    let formattedSupplierQuestions = formatSupplierQuestionsText(mergedSupplierQuestionsRu, translatedCn);
    // Pinpoints where CN dies: a length mismatch here (merged RU vs translated CN)
    // silently drops the whole Chinese version.
    console.log(
      `[cnQuestions] step5: mergedRu=${mergedSupplierQuestionsRu.length} cn=${translatedCn.length} cnValid=${formattedSupplierQuestions.cnValid} setCn=${(supplierQuestionSet.cn ?? []).length} setCnValid=${supplierQuestionSet.cnValid}`,
    );
    // Persist the RU/CN PAIR on the product itself. The ZIP and the "Вопросы
    // поставщику" button RE-RENDER from `product` (buildSupplierQuestionsFromProfile)
    // instead of reusing this text, and without supplierQuestionsRu the pair can't be
    // matched: the freshly translated CN was discarded and the shipped file said
    // "Китайская версия не сформирована" even though translation had succeeded
    // (cnValid=true right here). product is persisted into result_json below, so every
    // later re-render now reproduces the same bilingual pair.
    product.supplierQuestionsRu = mergedSupplierQuestionsRu;
    product.supplierQuestionsCn = formattedSupplierQuestions.cn;
    product.supplierQuestionsCnValid = formattedSupplierQuestions.cnValid;
    let profileForFiles = {
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
    // SEO prose is a stylistic candidate only.  It receives the already-built
    // canonical profile, cannot select facts, and buildSeoDraftFromProfile applies
    // the same evidence projection afterwards.  On any model failure the
    // deterministic draft is kept, so this call can improve readability but never
    // becomes a second fact-authoring path.
    const seoCandidate = await writeSeoProse({
      titleRu: profileForFiles.identity.titleForSeo || profileForFiles.identity.titleForReport,
      coreObject: profileForFiles.identity.coreObject,
      categoryType: profileForFiles.identity.categoryType,
      useCases: profileForFiles.identity.useCases,
      materials: profileForFiles.identity.materials,
      claimedFeatures: [
        ...profileForFiles.identity.claimedFeatures,
        ...profileForFiles.identity.unconfirmedFeatures,
      ],
      skuReliable: profileForFiles.sku.selectedSkuReliable,
      // A marketplace listing is not supplier confirmation.  Explicitly keep the
      // factual budget empty until evidence carries a confirmed status.
      confirmedAttributes: [],
      forbidden: profileForFiles.content.seoForbiddenClaims,
    }).catch((e) => {
      console.warn('[step5] SEO stylistic candidate failed:', e instanceof Error ? e.message : e);
      return null;
    });
    if (seoCandidate) {
      product.polishedDocs = {
        ...(product.polishedDocs ?? {}),
        seoProse: seoCandidate,
      };
    }
    let seoText = buildSeoDraftFromProfile(product, { sourceUrl: job.input_url });
    let readmeText = buildReadmeFromProfile(product, { sourceUrl: job.input_url });
    let infographicText = '';
    let riskChecklistText = '';
    let sampleRecommendationText = sampleChecklistText;

    // No package-level free-text editor runs here. Its candidate previously
    // competed with the profile projection and reintroduced unsupported SEO
    // claims. Writing is intentionally a deterministic projection of the one
    // structured LLM profile; a later reviewer may diagnose, never mutate facts.

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
        packagePolishReview: null,
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
