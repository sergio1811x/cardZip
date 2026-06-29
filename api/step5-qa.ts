import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, tryConsumeCredit } from '../src/services/subscriptionService';
import { buildMainMessage, buildSafeSummary } from '../src/core/messageBuilder';
import { runHardValidator, validateReport } from '../src/core/reportValidator';
import { validateGeneratedText, buildDecisionContext } from '../src/core/decisionLayer';
import { findWbCategoriesByKeywords } from '../src/db/queries/wbCategories';
import { formatSeoText } from '../src/core/seoFormatter';
import { formatOrderBrief } from '../src/core/orderBrief';
import { upsertProduct } from '../src/db/queries/products';
import { buildCacheKey } from '../src/lib/cache';
import { acquireStepLock } from '../src/lib/stepLock';
import { redis } from '../src/lib/redis';
import { runQaGate } from '../src/providers/expertQaGate';
import { runAutoFix } from '../src/providers/autoFix';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function safeIssues(value: any): string[] {
  return Array.isArray(value) ? value.map(String) : [];
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
    const supplierQs = [
      ...(decisionContext.intelligence.supplierQuestions?.ru ?? []),
      ...(decisionContext.intelligence.reportRules?.buyerMustCheck ?? []),
    ].slice(0, 10).map((q: string, i: number) => `${i + 1}. ${q}`).join('\n');

    const seoValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: seoText, reportType: 'seo', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const briefValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: briefText, reportType: 'buyerBrief', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    const supplierValidation = validateGeneratedText({ productIntelligence: decisionContext.intelligence, generatedText: supplierQs, reportType: 'supplierQuestions', categoryType: decisionContext.categoryType, marketDecision: decisionContext.market, weightDecision: decisionContext.weight });
    seoText = seoValidation.fixedText || seoText;
    briefText = briefValidation.fixedText || briefText;
    let supplierText = supplierValidation.fixedText || supplierQs;

    if (!seoValidation.ok || !briefValidation.ok || !supplierValidation.ok) {
      console.warn('[step5] file validators repaired:', [...seoValidation.errors, ...briefValidation.errors, ...supplierValidation.errors].join(', '));
    }

    await supabase.from('jobs').update({
      result_json: { ...result, product, generatedFiles: { seoText, briefText, supplierQuestions: supplierText } },
    }).eq('id', jobId);

    const keywords = (product.seoContent?.keywords ?? []).slice(0, 3);
    if (!keywords.length && product.titleRu) keywords.push(product.titleRu.split(' ').slice(0, 2).join(' '));
    const wbCats = keywords.length ? await findWbCategoriesByKeywords(keywords).catch(() => []) : [];
    const wbCategory = wbCats[0] ?? null;

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
      hasDirectAnalogs: decisionContext.market.confirmedDirectCount >= 5,
      wb429: !!(product as any).wb429,
      intelligence: decisionContext.intelligence as any,
    });
    let finalText = softValidation.ok ? mainText : softValidation.fixedText;

    const snapshot = result.analysisSnapshot ?? { market: product.marketDecision ?? decisionContext.market, economics: product.economics, productContext: product.productContext, purchasePrice: decisionContext.price, weight: decisionContext.weight, sku: decisionContext.sku };
    let hard = runHardValidator({
      analysisSnapshot: snapshot,
      artifacts: { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText },
    });
    ({ finalText, seoText, briefText, supplierText } = applySanitizedArtifacts(hard, { finalText, seoText, briefText, supplierText }));

    if (hard.block || !hard.canShowFullReport) {
      console.warn(`[step5] hard validator blocked: ${hard.issues.map(i => i.problem).join('; ')}`);
      await sendBlocked(job, product, hard.safeUserSummary?.mainRisk || 'Hard Validator заблокировал полный отчёт.');
      return res.status(200).json({ ok: true, blocked: true, source: 'hard' });
    }

    const qaMode = String(process.env.CARDZIP_QA_GATE_MODE ?? 'critical_only').toLowerCase();
    const hasNonLowWarnings = hard.warnings.some((w) => w.severity !== 'low');
    const mustRunQa = qaMode === 'always' || (qaMode === 'critical_only' && (hard.issues.length > 0 || hasNonLowWarnings));
    const qaResult = mustRunQa
      ? await runQaGate(snapshot as any, { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText }).catch(() => null)
      : { decision: 'PASS', canShowToUser: true, qualityScore: 8, confidence: 'medium', summary: 'Code hard validator passed; LLM QA skipped by policy.' } as any;

    if (!qaResult || qaResult.decision === 'BLOCK') {
      const reason = qaResult ? [...safeIssues(qaResult.criticalIssues), ...safeIssues(qaResult.issues)].join('; ') : 'QA Gate недоступен.';
      if (qaMode === 'always') {
        console.warn(`[step5] QA blocked/unavailable: ${reason}`);
        await sendBlocked(job, product, reason || 'QA Gate не разрешил полный отчёт.');
        return res.status(200).json({ ok: true, blocked: true, source: 'qa' });
      }
      console.warn(`[step5] QA unavailable in ${qaMode} mode; sending code-validated report: ${reason}`);
    }

    if (qaResult?.decision === 'FIX_REQUIRED') {
      const fixed = await runAutoFix(snapshot as any, { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText }, { ...qaResult, issues: safeIssues(qaResult.issues).length ? safeIssues(qaResult.issues) : safeIssues(qaResult.requiredEdits) } as any).catch(() => null);
      if (fixed?.userCard || fixed?.UserCard) finalText = String(fixed.userCard ?? fixed.UserCard);
      if (fixed?.seoText) seoText = String(fixed.seoText);
      if (fixed?.buyerBrief) briefText = String(fixed.buyerBrief);

      hard = runHardValidator({ analysisSnapshot: snapshot, artifacts: { userCard: finalText, seoText, buyerBrief: briefText, supplierQuestions: supplierText } });
      ({ finalText, seoText, briefText, supplierText } = applySanitizedArtifacts(hard, { finalText, seoText, briefText, supplierText }));
      if (hard.block || !hard.canShowFullReport) {
        await sendBlocked(job, product, hard.safeUserSummary?.mainRisk || 'Auto-Fix не смог безопасно исправить отчёт.');
        return res.status(200).json({ ok: true, blocked: true, source: 'autofix-hard' });
      }
    }

    // Charge only after hard validator + QA allow the full user report.
    const charged = await tryConsumeCredit(job.user_id);
    if (!charged) {
      console.warn(`[step5] no credits after QA for job ${job.id}`);
      await sendPaymentRequired(job);
      return res.status(200).json({ ok: true, blocked: true, source: 'payment_required' });
    }
    const freshStatus = await getStatus(job.user_id);
    // Do not rebuild the report after QA/Auto-Fix: that can discard repaired text.
    // Only update the credits line in the already validated artifact.
    finalText = applyCreditsLine(finalText, freshStatus.creditsRemaining ?? 0);

    await supabase.from('jobs').update({
      result_json: {
        ...result,
        product,
        generatedFiles: { seoText, briefText, supplierQuestions: supplierText },
        finalUserCard: finalText,
        qaResult,
      },
    }).eq('id', jobId);

    if (job.tg_message_id) await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    await bot.telegram.sendMessage(chatId, finalText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...keyboard,
    });

    await markSent(job.id);
    if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch((e) =>
      console.warn('[step5] Cache save failed:', e instanceof Error ? e.message : e),
    );

    console.log(`[step5] Job ${job.id} sent | soft=${softValidation.ok ? 'PASS' : softValidation.errors.length} | hard=PASS | qa=${qaResult?.decision ?? 'SKIPPED'}`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step5]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
