import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, tryConsumeCredit } from '../src/services/subscriptionService';
import { buildMainMessage, buildSafeSummary } from '../src/core/messageBuilder';
import { runHardValidator, validateReport } from '../src/core/reportValidator';
import { validateGeneratedText, buildDecisionContext, buildSupplierQuestions, buildCargoBrief, buildInfographicBrief, buildRiskChecklist, buildSampleRecommendation } from '../src/core/decisionLayer';
import { formatSeoText } from '../src/core/seoFormatter';
import { formatOrderBrief } from '../src/core/orderBrief';
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
      analysisSnapshot: result.analysisSnapshot,
    } as ProductWithContent & Record<string, any>;
    const decisionContext = buildDecisionContext(product);

    const safeRiskFlags = product.riskFlags ?? {
      hasBrand: false, isElectrical: false, isChildren: false,
      isCosmetic: false, isFood: false, isMedical: false,
      supplierOrdersLow: false, supplierTypeUnknown: false,
      weightMissing: false, sizeGridRelevant: false, marketDataUnreliable: true,
    };

    // Generate and validate all user-facing files before allowing full send.
    let seoText = formatSeoText(product, product.seoContent ?? {}, safeRiskFlags);
    let briefText = formatOrderBrief(
      product, product.seoContent ?? {}, product.economics,
      safeRiskFlags, job.input_url, product.budgets, product.conclusion,
    );
    const writerResult = result.writerResult ?? null;
    if (writerResult?.buyerBrief && String(writerResult.buyerBrief).length > 1200 && String(writerResult.buyerBrief).length > briefText.length * 0.9) {
      // Use LLM-enriched buyer brief only when it is actually richer; code validator still repairs it below.
      briefText = String(writerResult.buyerBrief);
    }
    let cargoText = buildCargoBrief(product, job.input_url);
    let infographicText = buildInfographicBrief(product);
    let riskChecklistText = buildRiskChecklist(product);
    let sampleRecommendationText = buildSampleRecommendation(product);
    const supplierQuestions = buildSupplierQuestions(product, decisionContext).ru;
    const writerQuestions = Array.isArray(writerResult?.supplierQuestionsRu) ? writerResult.supplierQuestionsRu : [];
    const seenSupplierQuestions = new Set<string>();
    const supplierQs = [...supplierQuestions, ...writerQuestions]
      .map((q: string) => String(q ?? '').replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter((q: string) => {
        if (!q) return false;
        const key = q.toLowerCase();
        if (seenSupplierQuestions.has(key)) return false;
        seenSupplierQuestions.add(key);
        return true;
      })
      .slice(0, 12)
      .map((q: string, i: number) => `${i + 1}. ${q}`)
      .join('\n');

    progress?.step('validate');
    const seoValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: seoText, reportType: 'seo', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const briefValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: briefText, reportType: 'buyerBrief', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const supplierValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: supplierQs, reportType: 'supplierQuestions', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const cargoValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: cargoText, reportType: 'buyerBrief', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const infographicValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: infographicText, reportType: 'buyerBrief', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const riskValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: riskChecklistText, reportType: 'buyerBrief', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const sampleValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: sampleRecommendationText, reportType: 'buyerBrief', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    seoText = seoValidation.fixedText || seoText;
    briefText = briefValidation.fixedText || briefText;
    let supplierText = supplierValidation.fixedText || supplierQs;
    cargoText = cargoValidation.fixedText || cargoText;
    infographicText = infographicValidation.fixedText || infographicText;
    riskChecklistText = riskValidation.fixedText || riskChecklistText;
    sampleRecommendationText = sampleValidation.fixedText || sampleRecommendationText;

    const fileErrors = [...seoValidation.errors, ...briefValidation.errors, ...supplierValidation.errors, ...cargoValidation.errors, ...infographicValidation.errors, ...riskValidation.errors, ...sampleValidation.errors];
    if (fileErrors.length) console.warn('[step5] file validators repaired:', fileErrors.join(', '));

    await supabase.from('jobs').update({
      result_json: { ...result, product, generatedFiles: { seoText, briefText, supplierQuestions: supplierText, cargoText, infographicText, riskChecklistText, sampleRecommendationText } },
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
    const { text: mainText, keyboard } = buildMainMessage(product, job.id, statusBeforeCharge as any, wbCategory);

    const softValidation = validateReport(mainText, (product as any).categoryType ?? decisionContext.categoryType ?? 'other', {
      hasPrice: !!decisionContext.price.calculationPriceYuan,
      hasWeight: decisionContext.weight.canUseForRoi,
      hasDirectAnalogs: true, // no-WB MVP: ROI is allowed only as manual scenario and checked by hard validator
      wb429: false,
      intelligence: decisionContext.intelligence as any,
    });
    let finalText = softValidation.ok ? mainText : softValidation.fixedText;

    const snapshot = result.analysisSnapshot ?? { market: product.marketDecision ?? decisionContext.market, economics: product.economics, productContext: product.productContext, purchasePrice: decisionContext.price, weight: decisionContext.weight, sku: decisionContext.sku };
    let hard = runHardValidator({
      analysisSnapshot: snapshot,
      artifacts: { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText, cargoText, infographicText, riskChecklistText, sampleRecommendationText },
    });
    ({ finalText, seoText, briefText, supplierText } = applySanitizedArtifacts(hard, { finalText, seoText, briefText, supplierText }));

    if (hard.block || !hard.canShowFullReport) {
      console.warn(`[step5] hard validator blocked: ${hard.issues.map(i => i.problem).join('; ')}`);
      progress?.message('Отчёт требует безопасного уточнения — отправляю короткое объяснение', 98);
      progress?.stop();
      await sendBlocked(job, product, hard.safeUserSummary?.mainRisk || 'Hard Validator заблокировал полный отчёт.');
      return res.status(200).json({ ok: true, blocked: true, source: 'hard' });
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
      } else if (!qaUnavailable || qaUnavailablePolicy === 'fail_closed') {
        console.warn(`[step5] QA blocked/unavailable: ${reason}`);
        progress?.message('QA не разрешил полный отчёт — отправляю безопасное объяснение', 98);
        progress?.stop();
        await sendBlocked(job, product, reason || 'QA Gate не разрешил полный отчёт.');
        return res.status(200).json({ ok: true, blocked: true, source: 'qa' });
      } else {
        console.warn(`[step5] QA unavailable; sending code-validated report by policy: ${reason}`);
        qaResult = { decision: 'PASS', canShowToUser: true, qualityScore: 7, confidence: 'medium', summary: 'LLM QA unavailable; code hard validator passed.', issues: [] } as any;
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
        progress?.message('Auto-Fix не смог безопасно исправить отчёт — отправляю короткое объяснение', 98);
        progress?.stop();
        await sendBlocked(job, product, hard.safeUserSummary?.mainRisk || 'Auto-Fix не смог безопасно исправить отчёт.');
        return res.status(200).json({ ok: true, blocked: true, source: 'autofix-hard' });
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

    await supabase.from('jobs').update({
      procurement_status: decisionContext.readiness.canRecommendSample ? 'ready_for_sample' : 'questions_ready',
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
        product,
        generatedFiles: { seoText, briefText, supplierQuestions: supplierText, cargoText, infographicText, riskChecklistText, sampleRecommendationText },
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
