import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { markSent } from '../src/db/queries/jobs';
import { getStatus } from '../src/services/subscriptionService';
import { buildMainMessage } from '../src/core/messageBuilder';
import { validateReport } from '../src/core/reportValidator';
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

// ─── Hard Validator (code, no LLM) ──────────────────────────────────────────
function runHardValidator(product: ProductWithContent, mainText: string): { ok: boolean; issues: string[]; block: boolean } {
  const issues: string[] = [];
  let block = false;

  // No 0 prices shown
  if (/\b0\s*[¥₽]/.test(mainText) && product.priceYuan <= 0) {
    issues.push('0 ¥/₽ в тексте');
  }

  // No Chinese in user text
  if (/[一-鿿]/.test(mainText)) {
    issues.push('Китайские символы в тексте');
  }

  // ROI without market
  const snapshot = (product as any).analysisSnapshot;
  if (snapshot && !snapshot.market?.marketConfirmed && /ROI\s*[:=]\s*\d/.test(mainText)) {
    issues.push('ROI без подтверждённого рынка');
    block = true;
  }

  return { ok: issues.length === 0, issues, block };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    if (!await acquireStepLock('step5', jobId)) return res.status(200).json({ ok: true, skip: true });

    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.sent_to_telegram) return res.status(200).json({ ok: true, skip: true });

    const result = job.result_json as any;
    const chatId = job.tg_chat_id;
    const product = result.product as ProductWithContent;

    // ─── Backward compat: if step4 didn't save freshStatus, fetch it ─────
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

    // ─── Generate file texts ─────────────────────────────────────────────
    const seoText = formatSeoText(product, product.seoContent, safeRiskFlags);
    const briefText = formatOrderBrief(
      product, product.seoContent, product.economics,
      safeRiskFlags, job.input_url, product.budgets, product.conclusion,
    );

    // Save generated files
    await supabase.from('jobs').update({
      result_json: { ...result, generatedFiles: { seoText, briefText } },
    }).eq('id', jobId);

    // ─── WB category fallback ────────────────────────────────────────────
    const keywords = (product.seoContent?.keywords ?? []).slice(0, 3);
    if (!keywords.length && product.titleRu) {
      keywords.push(product.titleRu.split(' ').slice(0, 2).join(' '));
    }
    const wbCats = keywords.length
      ? await findWbCategoriesByKeywords(keywords).catch(() => [])
      : [];
    const wbCategory = wbCats[0] ?? null;

    // ─── Build main message ──────────────────────────────────────────────
    const status = {
      plan: freshStatus.plan ?? 'free',
      creditsRemaining: freshStatus.creditsRemaining ?? 0,
      creditsTotal: 0,
      canGenerate: true,
      isTrial: freshStatus.isTrial ?? false,
    };
    const { text: mainText, keyboard: mainKb } = buildMainMessage(
      product, job.id, status as any, wbCategory,
    );

    // ─── Hard Validator ──────────────────────────────────────────────────
    const hardResult = runHardValidator(product, mainText);

    if (hardResult.block) {
      console.warn(`[step5] BLOCKED: ${hardResult.issues.join(', ')}`);
      // Delete progress message if still there
      if (job.tg_message_id) {
        await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
      }
      await bot.telegram.sendMessage(chatId,
        '⚠️ Анализ требует уточнения.\n\n' +
        'Не удалось подготовить надёжный отчёт.\n' +
        `Причина: ${hardResult.issues.join('; ')}\n\n` +
        'Попробуйте другой товар или уточните данные у поставщика.\n' +
        'Кредит не списан.',
      );
      await markSent(job.id);
      if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
      return res.status(200).json({ ok: true, blocked: true });
    }

    // ─── Step 4C: Soft validation (code) ────────────────────────────────
    const validation = validateReport(mainText, (product as any).categoryType ?? 'other', {
      hasPrice: product.priceYuan > 0,
      hasWeight: product.weightKg > 0,
      hasDirectAnalogs: !!(product.similarityData?.directCount && product.similarityData.directCount > 0),
      wb429: !!(product as any).wb429,
      intelligence: (product as any).intelligence ?? null,
    });
    let finalText = validation.ok ? mainText : validation.fixedText;

    if (!validation.ok) {
      console.warn(`[step5] Code validator: ${validation.errors.join(', ')}`);
    }

    // ─── Step 4D: Expert QA Gate (LLM) ───────────────────────────────────
    const snapshot = result.analysisSnapshot;
    if (snapshot) {
      const qaResult = await runQaGate(snapshot, { userCard: finalText }).catch(() => null);

      if (qaResult) {
        console.log(`[step5] QA: ${qaResult.decision} | score: ${qaResult.qualityScore} | issues: ${qaResult.issues.length}`);

        if (qaResult.decision === 'BLOCK') {
          const safe = qaResult.safeUserSummary ?? '⚠️ Анализ требует уточнения.';
          if (job.tg_message_id) await bot.telegram.deleteMessage(chatId, job.tg_message_id).catch(() => {});
          await bot.telegram.sendMessage(chatId, typeof safe === 'string' ? safe : '⚠️ Анализ требует уточнения.\nКредит не списан.');
          await markSent(job.id);
          if (redis) await redis.del(`processing:${job.user_id}`).catch(() => {});
          return res.status(200).json({ ok: true, blocked: true });
        }

        if (qaResult.decision === 'FIX_REQUIRED' && qaResult.issues.length > 0) {
          const fixed = await runAutoFix(snapshot, { userCard: finalText }, qaResult).catch(() => null);
          if (fixed?.userCard) {
            finalText = fixed.userCard;
            console.log(`[step5] Auto-fix applied`);
          }
        }
      }
    }

    // ─── Send ────────────────────────────────────────────────────────────
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

    const cacheKey = buildCacheKey(product.productId, product.titleCn, product.mainImageUrl);
    upsertProduct(job.user_id, { ...product, cacheKey }).catch((e) =>
      console.warn('[step5] Cache save failed:', e instanceof Error ? e.message : e),
    );

    console.log(`[step5] Job ${job.id} sent | validator: ${validation.ok ? 'PASS' : validation.errors.length + ' issues'} | hard: ${hardResult.ok ? 'PASS' : hardResult.issues.length + ' issues'}`);
    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step5]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
