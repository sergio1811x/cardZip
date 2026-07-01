import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, tryConsumeCredit } from '../src/services/subscriptionService';
import { buildMainMessage, buildSafeSummary } from '../src/core/messageBuilder';
import { runHardValidator, validateReport } from '../src/core/reportValidator';
import { buildDecisionContext } from '../src/core/decisionLayer';
import { ensureProductProcurementProfile, buildSupplierQuestionsFromProfile, translateSupplierQuestionsRuToCn, formatSupplierQuestionsText, buildBuyerBriefFromProfile, buildCargoBriefFromProfile, buildSampleChecklistFromProfile, buildSeoDraftFromProfile, buildReadmeFromProfile, validateDocuments, validateMainReport, validateProfile } from '../src/core/procurementProfile';
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
  if (/📦 Осталось:\s*\d+\s+анализов/i.test(text)) {
    return text.replace(/📦 Осталось:\s*\d+\s+анализов/i, line);
  }
  return `${text.replace(/\s+$/g, '')}\n\n${line}`;
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
    const product = {
      ...(result.product as ProductWithContent),
      intelligence: result.productIntelligence ?? result.intelligence ?? (result.product as any)?.intelligence,
      productProcurementProfile: result.productProcurementProfile ?? result.procurementProfile ?? (result.product as any)?.productProcurementProfile,
      procurementProfile: result.productProcurementProfile ?? result.procurementProfile ?? (result.product as any)?.procurementProfile,
      sourceUrl: job.input_url,
      analysisSnapshot: result.analysisSnapshot,
    } as ProductWithContent & Record<string, any>;
    const profile = ensureProductProcurementProfile(product, { sourceUrl: job.input_url });
    const profileValidation = validateProfile(profile);
    if (!profileValidation.ok) console.warn('[step5] profile validator:', profileValidation.errors.join('; '));
    product.productProcurementProfile = profileValidation.fixedProfile;
    product.procurementProfile = profileValidation.fixedProfile;
    const decisionContext = buildDecisionContext(product);

    // Generate every user-facing document from the single ProductProcurementProfile.
    // No document builder is allowed to re-detect productKind or infer category from raw attributes.
    const supplierQuestionSet = buildSupplierQuestionsFromProfile(product, { sourceUrl: job.input_url });
    const translatedCn = await translateSupplierQuestionsRuToCn(supplierQuestionSet.ru).catch(() => supplierQuestionSet.cn);
    const formattedSupplierQuestions = formatSupplierQuestionsText(supplierQuestionSet.ru, translatedCn);
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
      { filename: 'supplier_questions.txt', text: supplierText },
      { filename: 'buyer_brief.md', text: briefText },
      { filename: 'cargo_brief.md', text: cargoText },
      { filename: 'sample_checklist.md', text: sampleChecklistText },
      { filename: 'seo_draft.md', text: seoText },
      { filename: 'README.txt', text: readmeText },
    ], profileForFiles);
    if (docsValidation.errors.length) console.warn('[step5] profile document validators repaired:', docsValidation.errors.join('; '));
    for (const doc of docsValidation.fixedDocs) {
      if (doc.filename === 'supplier_questions.txt') supplierText = doc.text;
      if (doc.filename === 'buyer_brief.md') briefText = doc.text;
      if (doc.filename === 'cargo_brief.md') cargoText = doc.text;
      if (doc.filename === 'sample_checklist.md') sampleChecklistText = doc.text;
      if (doc.filename === 'seo_draft.md') seoText = doc.text;
      if (doc.filename === 'README.txt') readmeText = doc.text;
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

    const wbCategory = null;

    const currentStatus = await getStatus(job.user_id);
    const statusBeforeCharge = {
      plan: currentStatus.plan ?? 'free',
      creditsRemaining: currentStatus.creditsRemaining ?? 0,
      creditsTotal: 0,
      canGenerate: true,
      isTrial: currentStatus.isTrial ?? false,
    };
    const { text: mainTextRaw, keyboard } = buildMainMessage(product, job.id, statusBeforeCharge as any, wbCategory);
    const mainProfileValidation = validateMainReport(mainTextRaw);
    if (mainProfileValidation.errors.length) console.warn('[step5] main profile validator repaired:', mainProfileValidation.errors.join('; '));
    const mainText = mainProfileValidation.fixedText;

    const softValidation = validateReport(mainText, (product as any).categoryType ?? decisionContext.categoryType ?? 'other', {
      hasPrice: !!decisionContext.price.calculationPriceYuan,
      hasWeight: decisionContext.weight.canUseForRoi,
      hasDirectAnalogs: true,
      wb429: false,
      intelligence: decisionContext.intelligence as any,
    });
    let finalText = softValidation.ok ? mainText : softValidation.fixedText;

    const snapshot = result.analysisSnapshot ?? { market: product.marketDecision ?? decisionContext.market, economics: product.economics, productContext: product.productContext, purchasePrice: decisionContext.price, weight: decisionContext.weight, sku: decisionContext.sku };
    let hard = runHardValidator({
      analysisSnapshot: snapshot,
      artifacts: { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText, cargoText, sampleChecklistText, infographicText, riskChecklistText, sampleRecommendationText },
    });
    ({ finalText, seoText, briefText, supplierText } = applySanitizedArtifacts(hard, { finalText, seoText, briefText, supplierText }));

    if (hard.block || !hard.canShowFullReport) {
      // MVP rule: a successfully parsed product must still produce the procurement package.
      // Missing confirmations, risky claims, weak selected SKU, no WB market data, no weight,
      // or QA caution are warning/repair cases, not reasons to stop the analysis.
      // The deterministic validator has already sanitized artifacts above; keep sending the
      // repaired report and ZIP unless the deployment explicitly opts into fail-closed mode.
      const failClosed = String(process.env.CARDZIP_VALIDATOR_FAIL_CLOSED ?? 'false').toLowerCase() === 'true';
      console.warn(`[step5] hard validator warning-only: ${hard.issues.map(i => i.problem).join('; ')}`);
      if (failClosed) {
        progress?.message('Валидатор остановил отчёт в fail-closed режиме', 98);
        progress?.stop();
        await sendBlocked(job, product, hard.safeUserSummary?.mainRisk || 'Hard Validator заблокировал полный отчёт.');
        return res.status(200).json({ ok: true, blocked: true, source: 'hard_fail_closed' });
      }
    }

    progress?.step('qa');
    const qaMode = String(process.env.CARDZIP_QA_GATE_MODE ?? 'always').toLowerCase();
    const qaUnavailablePolicy = String(process.env.CARDZIP_QA_UNAVAILABLE_POLICY ?? 'send_code_validated').toLowerCase();
    const hasNonLowWarnings = hard.warnings.some((w) => w.severity !== 'low');
    const mustRunQa = qaMode !== 'off' && (qaMode === 'always' || (qaMode === 'critical_only' && (hard.issues.length > 0 || hasNonLowWarnings)));
    let qaResult = mustRunQa
      ? await runQaGate(snapshot as any, { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText }).catch(() => null)
      : { decision: 'PASS', canShowToUser: true, qualityScore: 8, confidence: 'medium', summary: 'Code hard validator passed; LLM QA skipped by policy.' } as any;

    if (!qaResult || qaResult.decision === 'BLOCK') {
      const reason = qaResult ? [...safeIssues(qaResult.criticalIssues), ...safeIssues(qaResult.issues), ...safeIssues(qaResult.warnings)].join('; ') : 'QA Gate недоступен.';
      const qaUnavailable = !qaResult || /QA (?:unavailable|fallback|Gate недоступен|all models failed)/i.test(reason);
      const marketOnlyBlock = !!qaResult && isOnlyNonBlockingMarketOrCautionIssue(reason);
      if (marketOnlyBlock) {
        console.warn(`[step5] QA market-only block downgraded to PASS: ${reason}`);
        qaResult = { ...qaResult, decision: 'PASS', canShowToUser: true, qualityScore: Math.max(6, Number(qaResult.qualityScore ?? 6)), confidence: qaResult.confidence ?? 'medium', summary: `QA warning downgraded: ${reason}`, issues: [] } as any;
      } else {
        const qaFailClosed = String(process.env.CARDZIP_QA_FAIL_CLOSED ?? 'false').toLowerCase() === 'true' || qaUnavailablePolicy === 'fail_closed';
        if (qaFailClosed) {
          console.warn(`[step5] QA blocked/unavailable in fail-closed mode: ${reason}`);
          progress?.message('QA остановил отчёт в fail-closed режиме', 98);
          progress?.stop();
          await sendBlocked(job, product, reason || 'QA Gate не разрешил полный отчёт.');
          return res.status(200).json({ ok: true, blocked: true, source: 'qa_fail_closed' });
        }
        console.warn(`[step5] QA warning-only; sending code-validated report: ${reason}`);
        qaResult = { decision: 'PASS', canShowToUser: true, qualityScore: Math.max(6, Number((qaResult as any)?.qualityScore ?? 6)), confidence: (qaResult as any)?.confidence ?? 'medium', summary: `QA warning downgraded: ${reason}`, issues: [] } as any;
      }
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
        const failClosed = String(process.env.CARDZIP_VALIDATOR_FAIL_CLOSED ?? 'false').toLowerCase() === 'true';
        console.warn(`[step5] post-autofix validator warning-only: ${hard.issues.map(i => i.problem).join('; ')}`);
        if (failClosed) {
          progress?.message('Auto-Fix не смог пройти fail-closed валидатор', 98);
          progress?.stop();
          await sendBlocked(job, product, hard.safeUserSummary?.mainRisk || 'Auto-Fix не смог безопасно исправить отчёт.');
          return res.status(200).json({ ok: true, blocked: true, source: 'autofix_hard_fail_closed' });
        }
      }
    }

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
