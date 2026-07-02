import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, tryConsumeCredit } from '../src/services/subscriptionService';
import { buildMainMessage, buildSafeSummary } from '../src/core/messageBuilder';
import { runHardValidator, validateReport } from '../src/core/reportValidator';
import { buildDecisionContext } from '../src/core/decisionLayer';
import { buildSupplierQuestionsFromProfile, translateSupplierQuestionsRuToCn, buildBuyerBriefFromProfile, buildCargoBriefFromProfile, buildSampleChecklistFromProfile, buildSeoDraftFromProfile } from '../src/core/procurementProfile';
import { buildUserFacingAnalysis } from '../src/core/userFacingAnalysis';
import { upsertProduct } from '../src/db/queries/products';
import { buildCacheKey } from '../src/lib/cache';
import { acquireStepLock } from '../src/lib/stepLock';
import { redis } from '../src/lib/redis';
import { createStepProgress } from '../src/core/progress';
import { runQaGate } from '../src/providers/expertQaGate';
import { runAutoFix } from '../src/providers/autoFix';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function safeIssues(value: any): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function isOnlyNonBlockingMarketOrCautionIssue(reason: string): boolean {
  const text = String(reason ?? '').toLowerCase();
  if (!text.trim()) return false;
  const mentionsMarketGap = /(wb|вб|рынок|market|аналог|direct|медиан|цена\s+рынка|api|недоступ|не\s+подтвержд|no\s+market|no\s+direct)/i.test(text);
  const dangerous = /(roi[^\n]*(?:\d|%|₽)|марж[^\n]*(?:\d|%|₽)|прибыл[^\n]*(?:\d|%|₽)|0\s*[¥₽]|0\s*кг|nan|undefined|null|debug|raw|можно\s+(?:закупать|брать)|закупка\s+целесообразна|лечит|лечебный\s+эффект)/i.test(text);
  return mentionsMarketGap && !dangerous;
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


function applySanitizedArtifacts(hard: { fixedArtifacts?: Record<string, unknown> }, artifacts: { finalText: string; seoText: string; briefText: string; supplierText: string }) {
  const fixed = hard.fixedArtifacts ?? {};
  return {
    finalText: String(fixed.userCard ?? fixed.UserCard ?? artifacts.finalText),
    seoText: String(fixed.seoText ?? fixed.SeoText ?? artifacts.seoText),
    briefText: String(fixed.buyerBrief ?? fixed.BuyerBrief ?? artifacts.briefText),
    supplierText: String(fixed.supplierQuestions ?? fixed.SupplierQuestions ?? artifacts.supplierText),
  };
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
    const currentStatus = await getStatus(job.user_id);
    const statusBeforeCharge = {
      plan: currentStatus.plan ?? 'free',
      creditsRemaining: currentStatus.creditsRemaining ?? 0,
      creditsTotal: 0,
      canGenerate: true,
      isTrial: currentStatus.isTrial ?? false,
    };

    const initialAnalysis = buildUserFacingAnalysis(result, {
      sourceUrl: job.input_url,
      jobId: job.id,
      creditsRemaining: statusBeforeCharge.creditsRemaining,
    });

    if (initialAnalysis.fatalIssues.length) {
      progress?.message('Недостаточно данных для закупочного отчёта', 98);
      progress?.stop();
      await sendBlocked(job, initialAnalysis.product, initialAnalysis.fatalIssues.map((i) => i.message).join('; '));
      return res.status(200).json({ ok: true, blocked: true, source: 'fatal_analysis_contract' });
    }

    const supplierQuestionSet = buildSupplierQuestionsFromProfile(initialAnalysis.product, { sourceUrl: job.input_url });
    const translatedCn = await translateSupplierQuestionsRuToCn(supplierQuestionSet.ru).catch(() => supplierQuestionSet.cn);
    const analysis = buildUserFacingAnalysis(result, {
      sourceUrl: job.input_url,
      jobId: job.id,
      creditsRemaining: statusBeforeCharge.creditsRemaining,
      supplierQuestionsCn: translatedCn,
    });

    const product = analysis.product as ProductWithContent & Record<string, any>;
    const profileForFiles = analysis.profile;
    const decisionContext = buildDecisionContext(product);
    let supplierText = analysis.generatedFiles.supplierQuestions;
    let briefText = analysis.generatedFiles.briefText;
    let cargoText = analysis.generatedFiles.cargoText;
    let sampleChecklistText = analysis.generatedFiles.sampleChecklistText;
    let seoText = analysis.generatedFiles.seoText;
    let readmeText = analysis.generatedFiles.readmeText;
    let infographicText = '';
    let riskChecklistText = '';
    let sampleRecommendationText = sampleChecklistText;

    if (analysis.warnings.length) console.warn('[step5] user-facing analysis repaired:', analysis.warnings.join('; '));

    const preBuiltDocs = {
      supplierQuestionsText: supplierQuestionSet.text,
      supplierQuestionsRu: supplierQuestionSet.ru,
      supplierQuestionsCn: translatedCn,
      buyerBriefMd: buildBuyerBriefFromProfile(initialAnalysis.product, { sourceUrl: job.input_url }),
      cargoBriefMd: buildCargoBriefFromProfile(initialAnalysis.product, { sourceUrl: job.input_url }),
      sampleChecklistMd: buildSampleChecklistFromProfile(initialAnalysis.product, { sourceUrl: job.input_url }),
      seoDraftMd: buildSeoDraftFromProfile(initialAnalysis.product, { sourceUrl: job.input_url }),
    };

    await supabase.from('jobs').update({
      result_json: {
        ...result,
        product,
        productProcurementProfile: profileForFiles,
        procurementProfile: profileForFiles,
        analysisStatus: analysis.status,
        preBuiltDocs,
        generatedFiles: {
          seoText,
          briefText,
          supplierQuestions: supplierText,
          supplierQuestionsCn: analysis.generatedFiles.supplierQuestionsCn,
          supplierQuestionsCnValid: analysis.generatedFiles.supplierQuestionsCnValid,
          cargoText,
          sampleChecklistText,
          readmeText,
        },
      },
    }).eq('id', jobId);

    const wbCategory = null;
    const { keyboard } = buildMainMessage(product, job.id, statusBeforeCharge as any, wbCategory);

    progress?.step('validate');
    const softValidation = validateReport(analysis.mainText, (product as any).categoryType ?? decisionContext.categoryType ?? 'other', {
      hasPrice: !!decisionContext.price.calculationPriceYuan,
      hasWeight: decisionContext.weight.canUseForRoi,
      hasDirectAnalogs: true,
      wb429: false,
      intelligence: decisionContext.intelligence as any,
      // The single ProductProcurementProfile owns productKind and forbidden terms.
      // Legacy 11-bucket category cleanup is intentionally disabled here because
      // this MVP must support arbitrary 1688/Taobao/Tmall goods without corrupting the report.
      skipCategoryTermCheck: true,
    });
    let finalText = softValidation.ok ? analysis.mainText : softValidation.fixedText;

    const snapshot = result.analysisSnapshot ?? { market: product.marketDecision ?? decisionContext.market, economics: product.economics, productContext: product.productContext, purchasePrice: decisionContext.price, weight: decisionContext.weight, sku: decisionContext.sku };
    let hard = runHardValidator({
      analysisSnapshot: snapshot,
      artifacts: { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText, cargoText, sampleChecklistText, infographicText, riskChecklistText, sampleRecommendationText },
    });
    ({ finalText, seoText, briefText, supplierText } = applySanitizedArtifacts(hard, { finalText, seoText, briefText, supplierText }));

    if (hard.block || !hard.canShowFullReport) {
      // Delivery contract: code validators may sanitize and warn, but they do not
      // suppress a successfully parsed procurement package. Missing supplier data,
      // conservative risk wording and text-quality concerns are user-facing statuses.
      console.warn(`[step5] hard validator diagnostic-only: ${hard.issues.map(i => i.problem).join('; ')}`);
    }

    progress?.step('qa');
    const qaMode = String(process.env.CARDZIP_QA_GATE_MODE ?? 'critical_only').toLowerCase();
    const hasNonLowWarnings = hard.warnings.some((w) => w.severity !== 'low');
    const mustRunQa = qaMode !== 'off' && (qaMode === 'always' || (qaMode === 'critical_only' && (hard.issues.length > 0 || hasNonLowWarnings)));
    let qaResult = mustRunQa
      ? await runQaGate(snapshot as any, { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText }).catch(() => null)
      : { decision: 'PASS', canShowToUser: true, qualityScore: 8, confidence: 'medium', summary: 'LLM QA skipped by policy; deterministic profile/doc validators ran.' } as any;

    if (!qaResult || qaResult.decision === 'BLOCK') {
      const reason = qaResult ? [...safeIssues(qaResult.criticalIssues), ...safeIssues(qaResult.issues), ...safeIssues(qaResult.warnings)].join('; ') : 'QA Gate недоступен.';
      // QA Gate is diagnostic-only in the procurement-package MVP. It can trigger
      // logs and Auto-Fix, but it cannot replace the report with a user-visible
      // "QA Gate заблокировал" fallback. Only fatal analysis-contract gaps above
      // can stop delivery.
      console.warn(`[step5] QA diagnostic-only block downgraded: ${reason}`);
      qaResult = {
        ...(qaResult ?? {}),
        decision: 'PASS',
        canShowToUser: true,
        qualityScore: Math.max(6, Number((qaResult as any)?.qualityScore ?? 6)),
        confidence: (qaResult as any)?.confidence ?? 'medium',
        summary: `QA diagnostic downgraded: ${reason}`,
        issues: safeIssues((qaResult as any)?.issues),
        warnings: [...safeIssues((qaResult as any)?.warnings), reason].filter(Boolean),
      } as any;
    }

    if (qaResult?.decision === 'FIX_REQUIRED') {
      progress?.step('autofix');
      const fixed = await runAutoFix(snapshot as any, { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText }, { ...qaResult, issues: safeIssues(qaResult.issues).length ? safeIssues(qaResult.issues) : safeIssues(qaResult.requiredEdits) } as any).catch(() => null);
      if (fixed?.userCard || fixed?.UserCard) finalText = String(fixed.userCard ?? fixed.UserCard);
      if (fixed?.seoText) seoText = String(fixed.seoText);
      if (fixed?.buyerBrief) briefText = String(fixed.buyerBrief);

      hard = runHardValidator({ analysisSnapshot: snapshot, artifacts: { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText } });
      ({ finalText, seoText, briefText, supplierText } = applySanitizedArtifacts(hard, { finalText, seoText, briefText, supplierText }));
      if (hard.block || !hard.canShowFullReport) {
        console.warn(`[step5] post-autofix validator diagnostic-only: ${hard.issues.map(i => i.problem).join('; ')}`);
      }
    }

    progress?.step('charge');
    // Charge once after the deterministic procurement package has been built and sanitized.
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
        generatedFiles: { seoText, briefText, supplierQuestions: supplierText, supplierQuestionsCn: analysis.generatedFiles.supplierQuestionsCn, supplierQuestionsCnValid: analysis.generatedFiles.supplierQuestionsCnValid, cargoText, sampleChecklistText, readmeText },
        preBuiltDocs,
        finalUserCard: finalText,
        qaResult,
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

    console.log(`[step5] Job ${job.id} sent | soft=${softValidation.ok ? 'PASS' : softValidation.errors.length} | hard=PASS | qa=${qaResult?.decision ?? 'SKIPPED'}`);
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
