import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { canonicalizeProduct } from '../src/providers/productCanonicalizer';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return fallback;
}

function makeFallbackQuery(raw: any): string {
  return safeString(raw?.titleEn) || safeString(raw?.categoryName) || safeString(raw?.titleCn);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'elim_done') return res.status(200).json({ ok: true, skip: true });
    if (!await acquireStepLock('step2', jobId)) return res.status(200).json({ ok: true, skip: true });
    await extendProcessingLock(job.user_id);

    await supabase.from('jobs').update({ status: 'ai_processing', updated_at: new Date().toISOString() }).eq('id', jobId);

    const raw = (job.result_json as any).rawProduct;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'ai')
      : null;

    // Single LLM call: Product Canonicalizer (replaces SEO + Understanding + Intelligence)
    const productContext = await canonicalizeProduct({
      offerId: raw.productId,
      titleCn: raw.titleCn,
      titleRu: raw.titleEn,
      titleEn: raw.titleEn,
      categoryName: raw.categoryName,
      attributes: raw.attributes,
      skus: raw.skus,
      price: raw.priceYuan,
      priceRange: raw.priceRange,
      weightKg: raw.weightKg,
      mainImageUrl: raw.mainImageUrl,
      sold: raw.sold,
      stock: raw.stock,
    }).catch(() => null);

    // Backward-compatible fields from productContext
    const fallbackQuery = makeFallbackQuery(raw);
    const wbCoreQuery = productContext?.wbSearch?.coreQuery || fallbackQuery;
    const categoryType = productContext?.identity?.categoryType ?? 'other';
    const validatedQueries = productContext?.wbSearch?.queryLadder?.length ? productContext.wbSearch.queryLadder : [fallbackQuery].filter(Boolean);

    // Temporary SEO (will be regenerated in step4 with market data)
    const seoContent = {
      titleRu: productContext?.titles?.cleanRu ?? raw.titleEn ?? raw.titleCn,
      description: '',
      bullets: [] as string[],
      keywords: validatedQueries,
      characteristics: productContext?.facts ?? {},
    };

    progress?.stop();

    console.log(`[step2-ai] ${seoContent.titleRu?.slice(0, 40)} | cat: ${categoryType} | wbCore: ${wbCoreQuery}`);

    await supabase.from('jobs').update({
      status: 'ai_done',
      result_json: {
        ...(job.result_json as any),
        seoContent,
        productContext,
        wbCoreQuery,
        categoryType,
        validatedQueries,
        // backward compat for step3
        productStructure: productContext ? {
          coreObject: productContext.identity.coreObject || fallbackQuery,
          productType: productContext.identity.productType || fallbackQuery,
          material: Object.entries(productContext.facts).filter(([k]) => k.includes('материал')).map(([,v]) => v),
          hardConflicts: productContext.conflicts.filter(c => c.severity === 'high').map(c => c.field),
          softConflicts: productContext.conflicts.filter(c => c.severity !== 'high').map(c => c.field),
          directAnalogBlockers: productContext.wbSearch.rejectRules,
          marketSynonyms: productContext.wbSearch.queryLadder,
          mustKeep: productContext.wbSearch.mustInclude,
          doNotSearch: productContext.wbSearch.mustExclude,
          audience: productContext.identity.audience,
        } : {
          coreObject: fallbackQuery,
          productType: fallbackQuery,
          material: [],
          hardConflicts: [],
          softConflicts: [],
          directAnalogBlockers: [],
          marketSynonyms: validatedQueries,
          mustKeep: [],
          doNotSearch: [],
          audience: '',
        },
        queryPlan: productContext ? {
          L1_exact: productContext.wbSearch.queryLadder.slice(0, 2),
          L2_commercial: productContext.wbSearch.queryLadder.slice(2, 4),
          L3_subtype: [],
          L4_core: [productContext.identity.coreObject],
          L5_category: [],
        } : {
          L1_exact: validatedQueries.slice(0, 1),
          L2_commercial: validatedQueries.slice(1, 2),
          L3_subtype: [],
          L4_core: [fallbackQuery].filter(Boolean),
          L5_category: [],
        },
        productLexicon: productContext ? {
          mainTerms: [productContext.identity.coreObject],
          hardNegativeTerms: productContext.wbSearch.mustExclude,
        } : {
          mainTerms: [fallbackQuery].filter(Boolean),
          hardNegativeTerms: [],
        },
      },
    }).eq('id', jobId);

    // Chain → step3-market
    const host = req.headers.host || 'card-zip.vercel.app';
    let sent = false;
    for (let i = 0; i < 2 && !sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        const response = await fetch(`https://${host}/api/step3-market`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        if (!response.ok) throw new Error(`step3 HTTP ${response.status}`);
        sent = true;
      } catch {
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!sent) {
      const { handleStepError } = require('../src/lib/stepError');
      await handleStepError(jobId, 'step3_trigger_failed', bot);
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step2-ai]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
