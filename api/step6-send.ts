import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus, consumeCredit } from '../src/services/subscriptionService';
import { track } from '../src/services/analyticsService';
import { buildMainMessage } from '../src/core/messageBuilder';
import { validateReport, runHardValidator, type HardValidatorSafeSummary } from '../src/core/reportValidator';
import { findWbCategoriesByKeywords } from '../src/db/queries/wbCategories';
import { formatSeoText } from '../src/core/seoFormatter';
import { formatOrderBrief } from '../src/core/orderBrief';
import { upsertProduct } from '../src/db/queries/products';
import { buildCacheKey } from '../src/lib/cache';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { redis } from '../src/lib/redis';
import { runQaGate } from '../src/providers/expertQaGate';
import { runAutoFix } from '../src/providers/autoFix';
import { createStepProgress } from '../src/core/progress';
import type { ProductWithContent } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSafeSummary(summary: HardValidatorSafeSummary, reason?: string): string {
  const lines = [
    '⚠️ <b>Анализ требует уточнения</b>',
    '',
    `<b>Статус:</b> ${escapeHtml(summary.status)}`,
    `<b>Вердикт:</b> ${escapeHtml(summary.verdict)}`,
    `<b>Главный риск:</b> ${escapeHtml(summary.mainRisk)}`,
    `<b>Следующий шаг:</b> ${escapeHtml(summary.nextStep)}`,
    `<b>Не делать:</b> ${escapeHtml(summary.doNotDo)}`,
  ];
  if (reason) lines.push('', `<i>${escapeHtml(reason)}</i>`);
  lines.push('', 'Кредит не списан.');
  return lines.join('\n');
}

function isQaUnavailable(qaResult: { decision: string; issues?: string[] } | null): boolean {
  if (!qaResult) return true;
  return (qaResult.issues ?? []).some((issue) => /QA\s+(?:skipped|fallback)|no API key|all models failed/i.test(String(issue)));
}

function getArtifactUserCard(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const direct = obj.userCard ?? obj.UserCard;
    if (typeof direct === 'string' && direct.trim()) return direct;
    const nested = obj.artifacts;
    if (nested && typeof nested === 'object') {
      const nestedCard = (nested as Record<string, unknown>).userCard;
      if (typeof nestedCard === 'string' && nestedCard.trim()) return nestedCard;
    }
  }
  return fallback;
}

async function cleanupAndBlock(job: any, chatId: number, message: string): Promise<void> {
  if (job.tg_message_id) await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
  await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
  await markSent(job.id);
  if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    console.log(`[step6] Start: ${jobId}`);
    if (!await acquireStepLock('step6', jobId)) {
      console.log(`[step6] Duplicate blocked for job ${jobId}`);
      return res.status(200).json({ ok: true, skip: true });
    }

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    await extendProcessingLock(job.user_id);

    const result = job.result_json as any;
    const chatId = job.tg_chat_id;
    const product = result?.product as ProductWithContent | undefined;

    if (!product) {
      console.warn('[step6] BLOCKED: missing product payload');
      await cleanupAndBlock(job, chatId, '⚠️ <b>Анализ требует уточнения</b>\n\nНе удалось собрать карточку товара. Кредит не списан.');
      return res.status(200).json({ ok: true, blocked: true, reason: 'missing_product' });
    }

    // Progress: QA phase
    const progress = job.tg_message_id
      ? createStepProgress(bot, chatId, job.tg_message_id, 'qa')
      : null;

    let freshStatus = result.freshStatus;
    if (!freshStatus) {
      const s = await getStatus(job.user_id);
      freshStatus = { creditsRemaining: s.creditsRemaining, plan: s.plan, isTrial: s.isTrial };
    }

    const safeRiskFlags = product.riskFlags ?? {
      hasBrand: false, isElectrical: false, isChildren: false,
      isCosmetic: false, isFood: false, isMedical: false,
      supplierOrdersLow: false, supplierTypeUnknown: false,
      weightMissing: false, sizeGridRelevant: false, marketDataUnreliable: false,
    };

    const seoText = formatSeoText(product, product.seoContent, safeRiskFlags);
    const briefText = formatOrderBrief(
      product, product.seoContent, product.economics,
      safeRiskFlags, job.input_url, product.budgets, product.conclusion,
    );

    const keywords = (product.seoContent?.keywords ?? []).slice(0, 3);
    if (!keywords.length && product.titleRu) {
      keywords.push(product.titleRu.split(' ').slice(0, 2).join(' '));
    }
    const wbCats = keywords.length
      ? await findWbCategoriesByKeywords(keywords).catch(() => [])
      : [];
    const wbCategory = wbCats[0] ?? null;

    const status = {
      plan: freshStatus.plan ?? 'free',
      creditsRemaining: Math.max(0, (freshStatus.creditsRemaining ?? 0) - 1),
      creditsTotal: 0,
      canGenerate: true,
      isTrial: freshStatus.isTrial ?? false,
    };
    const { text: mainText, keyboard: mainKb } = buildMainMessage(
      product, job.id, status as any, wbCategory,
    );

    // ─── Soft validation (code) ─────────────────────────────────────────
    const validation = validateReport(mainText, (product as any).categoryType ?? 'other', {
      hasPrice: product.priceYuan > 0,
      hasWeight: product.weightKg > 0,
      hasDirectAnalogs: !!(product.similarityData?.directCount && product.similarityData.directCount > 0),
      wb429: !!(product as any).wb429,
      intelligence: (product as any).intelligence ?? null,
    });
    let finalText = validation.ok ? mainText : validation.fixedText;

    if (!validation.ok) {
      console.warn(`[step6] Code validator: ${validation.errors.join(', ')}`);
    }

    // ─── Hard Validator (code, instant) ─────────────────────────────────
    const snapshot = result.analysisSnapshot;
    if (!snapshot) {
      console.warn('[step6] BLOCKED: missing AnalysisSnapshot');
      const fallbackSummary: HardValidatorSafeSummary = {
        status: 'черновик',
        verdict: 'Полный отчёт заблокирован: не собран единый AnalysisSnapshot.',
        mainRisk: 'Нет единого источника правды для цены, рынка и экономики.',
        nextStep: 'Повторить анализ или проверить pipeline step4.',
        doNotDo: 'Не считать ROI/маржу и не закупать партию по этому отчёту.',
      };
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(fallbackSummary));
      return res.status(200).json({ ok: true, blocked: true, reason: 'missing_snapshot' });
    }

    const artifacts = {
      userCard: finalText,
      seoText,
      buyerBrief: briefText,
      lastMessage: result.writerResult?.lastMessage ?? '',
    };

    let hardResult = runHardValidator({ analysisSnapshot: snapshot, artifacts });
    if (hardResult.fixedArtifacts?.userCard && !hardResult.block) {
      finalText = String(hardResult.fixedArtifacts.userCard);
    }

    if (hardResult.block || !hardResult.canShowFullReport) {
      console.warn(`[step6] HARD BLOCKED: ${hardResult.issues.map(i => i.problem).join('; ')}`);
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'Полный отчёт не показан: сработал кодовый валидатор.'));
      return res.status(200).json({ ok: true, blocked: true, reason: 'hard_validator' });
    }

    // ─── Expert QA Gate (LLM, 18с per model) ────────────────────────────
    const qaResult = await runQaGate(snapshot, { ...artifacts, userCard: finalText }).catch(() => null);

    if (isQaUnavailable(qaResult)) {
      console.warn('[step6] QA unavailable — blocking full report');
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'QA Gate недоступен, поэтому полный отчёт не отправлен.'));
      return res.status(200).json({ ok: true, blocked: true, reason: 'qa_unavailable' });
    }

    console.log(`[step6] QA: ${qaResult!.decision} | score: ${qaResult!.qualityScore} | issues: ${qaResult!.issues.length}`);

    if (qaResult!.decision === 'BLOCK') {
      console.warn('[step6] QA BLOCKED full report');
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'Полный отчёт не показан: QA Gate заблокировал результат.'));
      return res.status(200).json({ ok: true, blocked: true, reason: 'qa_block' });
    }

    // ─── Auto-Fix (LLM, 10с per model, only if FIX_REQUIRED) ───────────
    if (qaResult!.decision === 'FIX_REQUIRED' && qaResult!.issues.length > 0) {
      const fixed = await runAutoFix(snapshot, { ...artifacts, userCard: finalText }, qaResult!).catch(() => null);
      finalText = getArtifactUserCard(fixed, finalText);
      hardResult = runHardValidator({ analysisSnapshot: snapshot, artifacts: { ...artifacts, userCard: finalText } });
      if (hardResult.block || !hardResult.canShowFullReport) {
        console.warn('[step6] BLOCKED after auto-fix');
        progress?.stop();
        await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'После Auto-Fix остались критичные проблемы.'));
        return res.status(200).json({ ok: true, blocked: true, reason: 'autofix_hard_validator' });
      }
    }

    // ─── Send ───────────────────────────────────────────────────────────
    progress?.stop();
    await consumeCredit(job.user_id);
    await track(job.user_id, 'generation_done', { url: job.input_url });

    if (job.tg_message_id) {
      await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
    }
    await bot.telegram.sendMessage(chatId, finalText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...mainKb,
    });

    await markSent(job.id);
    if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});

    await supabase.from('jobs').update({
      result_json: { ...result, generatedFiles: { seoText, briefText } },
    }).eq('id', jobId);

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch((e) =>
      console.warn('[step6] Cache save failed:', e instanceof Error ? e.message : e),
    );

    console.log(`[step6] Job ${job.id} sent | hard: ${hardResult.ok ? 'PASS' : hardResult.issues.length + ' issues'} | qa: ${qaResult!.decision}`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step6]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
