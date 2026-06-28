import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { runExpertWriter } from '../src/providers/expertWriter';
import { redis } from '../src/lib/redis';
import type { ProductWithContent } from '../src/types';
import { buildAnalysisSnapshot as buildCoreAnalysisSnapshot, type AnalysisSnapshot } from '../src/core/analysisSnapshot';
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
import { runQaGate } from '../src/providers/expertQaGate';
import { runAutoFix } from '../src/providers/autoFix';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function buildAnalysisSnapshot(product: ProductWithContent, result: any, jobUrl: string): AnalysisSnapshot {
  const directAnalogs = ((product as any).marketEvidence?.directAnalogs ?? product.wbData?.allCards ?? [])
    .filter((card: any) => card && Number(card.price) > 0)
    .map((card: any) => ({
      title: String(card.title ?? card.name ?? '').trim(),
      priceRub: Number(card.price),
      matchLevel: 'direct' as const,
      confidence: Math.max(0, Math.min(100, Number(card.similarity ?? card.confidence ?? 0))),
    }))
    .filter((card: any) => card.title || card.priceRub > 0);

  const similarityData = (product as any).similarityData ?? {};
  const wbFiltered = product.wbFiltered as any;
  const economics = product.economics as any;
  const marketConfirmed = Boolean(
    wbFiltered?.relevantCount >= 3 &&
    wbFiltered?.medianPrice > 0 &&
    directAnalogs.length >= 3 &&
    !economics?.isSyntheticPrice
  );

  return buildCoreAnalysisSnapshot({
    offerId: product.productId,
    sourceUrl: jobUrl,
    raw1688: {
      ...((result?.rawProduct ?? {}) as Record<string, unknown>),
      ...product,
      attributesRaw: Object.fromEntries(((product as any).attributes ?? []).map((a: any) => [String(a.name ?? ''), a.value]).filter(([k]) => Boolean(k))),
      photosCount: Array.isArray(result?.imageUrls) ? result.imageUrls.length : 0,
    },
    productContext: (product as any).productContext ?? result?.productContext ?? null,
    supplier: {
      name: product.supplierName,
      type: product.supplierType,
      rating: product.supplierRating,
      orders: product.sold,
      moq: product.moq,
    },
    selectedSkuId: (product as any).selectedSkuId ?? null,
    market: {
      directAnalogsCount: marketConfirmed ? directAnalogs.length : 0,
      similarAnalogsCount: Number(similarityData.similarCount ?? 0),
      broadCategoryCount: Number(similarityData.categoryCount ?? 0),
      crossBorderCount: Number(similarityData.crossBorderCount ?? 0),
      marketConfirmed,
      displayedMainPriceRub: marketConfirmed ? wbFiltered.medianPrice : null,
      displayedMainPriceType: marketConfirmed ? 'median' : 'unknown',
      canUseForEconomics: marketConfirmed,
      rejectedReason: marketConfirmed ? undefined : 'Недостаточно прямых локальных аналогов WB 85%+ для экономики.',
      directAnalogs,
    },
    economics: {
      status: economics?.status,
      purchasePriceCny: product.priceYuan,
      costRub: economics?.costRub,
      sellPriceRub: marketConfirmed ? wbFiltered?.medianPrice : null,
      marginRub: marketConfirmed ? economics?.marginRub : null,
      roiPercent: marketConfirmed ? economics?.roiPercent : null,
      assumptions: economics?.assumptions ?? [],
      missing: [
        ...(!product.priceYuan || product.priceYuan <= 0 ? ['purchasePriceCny'] : []),
        ...(!product.weightKg || product.weightKg <= 0 ? ['packedWeightKg'] : []),
        ...(!marketConfirmed ? ['confirmedMarketPrice'] : []),
      ],
      canShowRoi: Boolean(marketConfirmed && economics?.roiPercent != null && !economics?.weightMissing && !economics?.isSyntheticPrice),
      canShowMargin: Boolean(marketConfirmed && economics?.marginRub != null && !economics?.weightMissing && !economics?.isSyntheticPrice),
    },
    missingData: [],
    riskFlags: (product as any).productContext?.riskTags ?? [],
  });
}

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
    if (!await acquireStepLock('step4', jobId)) return res.status(200).json({ ok: true, skip: true });

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'done' || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    await extendProcessingLock(job.user_id);

    const result = job.result_json as any;
    const product = result.product as ProductWithContent;
    const chatId = job.tg_chat_id;

    if (!product) {
      console.warn('[step4] BLOCKED: missing product payload');
      await cleanupAndBlock(job, chatId, '⚠️ <b>Анализ требует уточнения</b>\n\nНе удалось собрать карточку товара. Кредит не списан.');
      return res.status(200).json({ ok: true, blocked: true, reason: 'missing_product' });
    }

    const progress = job.tg_message_id
      ? createStepProgress(bot, chatId, job.tg_message_id, 'send')
      : null;

    // ─── 4A: Build AnalysisSnapshot ─────────────────────────────────────
    const snapshot = buildAnalysisSnapshot(product, result, job.input_url);

    // ─── 4B: Expert Writer (LLM, 20с timeout per model) ────────────────
    const writerResult = await runExpertWriter(snapshot).catch(() => null);
    if (writerResult) {
      product.seoContent = {
        ...product.seoContent,
        titleRu: writerResult.seoTitle || product.seoContent?.titleRu,
        description: writerResult.seoDescription || product.seoContent?.description || '',
        bullets: writerResult.seoBullets?.length ? writerResult.seoBullets : product.seoContent?.bullets ?? [],
        keywords: writerResult.seoKeywords?.length ? writerResult.seoKeywords : product.seoContent?.keywords ?? [],
        characteristics: writerResult.seoCharacteristics ?? product.seoContent?.characteristics ?? {},
      };
    }

    // ─── 4C: Generate file texts ────────────────────────────────────────
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

    // ─── 4D: Soft validation (code) ─────────────────────────────────────
    const validation = validateReport(mainText, (product as any).categoryType ?? 'other', {
      hasPrice: product.priceYuan > 0,
      hasWeight: product.weightKg > 0,
      hasDirectAnalogs: !!(product.similarityData?.directCount && product.similarityData.directCount > 0),
      wb429: !!(product as any).wb429,
      intelligence: (product as any).intelligence ?? null,
    });
    let finalText = validation.ok ? mainText : validation.fixedText;

    if (!validation.ok) {
      console.warn(`[step4] Code validator: ${validation.errors.join(', ')}`);
    }

    // ─── 4E: Hard Validator (code, always) ──────────────────────────────
    const artifacts = {
      userCard: finalText,
      seoText,
      buyerBrief: briefText,
      lastMessage: writerResult?.lastMessage ?? '',
    };

    let hardResult = runHardValidator({ analysisSnapshot: snapshot, artifacts });
    if (hardResult.fixedArtifacts?.userCard && !hardResult.block) {
      finalText = String(hardResult.fixedArtifacts.userCard);
    }

    if (hardResult.block || !hardResult.canShowFullReport) {
      console.warn(`[step4] HARD BLOCKED: ${hardResult.issues.map(i => i.problem).join('; ')}`);
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'Полный отчёт не показан: сработал кодовый валидатор.'));
      return res.status(200).json({ ok: true, blocked: true, reason: 'hard_validator' });
    }

    // ─── 4F: Expert QA Gate (LLM, 18с timeout per model) ────────────────
    const qaResult = await runQaGate(snapshot, { ...artifacts, userCard: finalText }).catch(() => null);

    if (isQaUnavailable(qaResult)) {
      console.warn('[step4] QA unavailable — blocking full report');
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'QA Gate недоступен, поэтому полный отчёт не отправлен.'));
      return res.status(200).json({ ok: true, blocked: true, reason: 'qa_unavailable' });
    }

    console.log(`[step4] QA: ${qaResult!.decision} | score: ${qaResult!.qualityScore} | issues: ${qaResult!.issues.length}`);

    if (qaResult!.decision === 'BLOCK') {
      console.warn('[step4] QA BLOCKED full report');
      progress?.stop();
      await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'Полный отчёт не показан: QA Gate заблокировал результат.'));
      return res.status(200).json({ ok: true, blocked: true, reason: 'qa_block' });
    }

    // ─── 4G: Auto-Fix (LLM, 10с timeout per model, only if FIX_REQUIRED) ─
    if (qaResult!.decision === 'FIX_REQUIRED' && qaResult!.issues.length > 0) {
      const fixed = await runAutoFix(snapshot, { ...artifacts, userCard: finalText }, qaResult!).catch(() => null);
      finalText = getArtifactUserCard(fixed, finalText);
      hardResult = runHardValidator({ analysisSnapshot: snapshot, artifacts: { ...artifacts, userCard: finalText } });
      if (hardResult.block || !hardResult.canShowFullReport) {
        console.warn('[step4] BLOCKED after auto-fix');
        progress?.stop();
        await cleanupAndBlock(job, chatId, formatSafeSummary(hardResult.safeUserSummary, 'После Auto-Fix остались критичные проблемы.'));
        return res.status(200).json({ ok: true, blocked: true, reason: 'autofix_hard_validator' });
      }
    }

    // ─── 4H: Send ───────────────────────────────────────────────────────
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
      result_json: {
        ...result,
        product: { ...product, seoContent: product.seoContent },
        analysisSnapshot: snapshot,
        writerResult,
        generatedFiles: { seoText, briefText },
      },
    }).eq('id', jobId);

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch((e) =>
      console.warn('[step4] Cache save failed:', e instanceof Error ? e.message : e),
    );

    console.log(`[step4] Job ${job.id} sent | validator: ${validation.ok ? 'PASS' : validation.errors.length + ' issues'} | hard: ${hardResult.ok ? 'PASS' : hardResult.issues.length + ' issues'} | qa: ${qaResult!.decision}`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step4]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
