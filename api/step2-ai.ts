import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { aiContentGenerator } from '../src/providers/aiContentGenerator';
import { analyzeProduct, generateProductIntelligence } from '../src/providers/productUnderstanding';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import type { AiContentResult } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

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

    const seoContent = await aiContentGenerator.generate({
      titleCn: raw.titleCn,
      titleEn: raw.titleEn,
      description: raw.description,
      priceYuan: raw.priceYuan,
      moq: raw.moq,
      weightKg: raw.weightKg,
      supplierName: raw.supplierName,
      supplierRating: raw.supplierRating,
      categoryName: raw.categoryName,
      attributes: raw.attributes,
    }).catch((): AiContentResult => ({
      titleRu: raw.titleEn || raw.titleCn,
      description: '', bullets: [], keywords: [],
      characteristics: {}, isFallback: true,
    }));

    // Product Analysis: Understanding + Lexicon + Queries (один LLM вызов)
    const analysisPromise = analyzeProduct({
      titleCn: raw.titleCn,
      titleEn: raw.titleEn,
      categoryName: raw.categoryName,
      attributes: raw.attributes,
      description: raw.description,
      skus: raw.skus,
    }).catch(() => null);

    // Product Intelligence — параллельно с analyzeProduct
    const intelligencePromise = generateProductIntelligence({
      titleCn: raw.titleCn,
      titleRu: seoContent?.titleRu,
      titleEn: raw.titleEn,
      categoryName: raw.categoryName,
      attributes: raw.attributes,
      skus: raw.skus,
      price: raw.priceYuan,
    }).catch(() => null);

    const [analysis, intelligence] = await Promise.all([analysisPromise, intelligencePromise]);

    const productStructure = analysis?.structure ?? null;
    const productLexicon = analysis?.lexicon ?? null;
    const queryPlan = analysis?.queryPlan ?? null;
    const validatedQueries = analysis?.validatedQueries ?? [];
    const wbCoreQuery = intelligence?.wbSearch?.wbCoreQuery || analysis?.wbCoreQuery || productStructure?.coreObject || '';
    const categoryType = analysis?.categoryType ?? 'other';

    progress?.stop();

    console.log(`[step2-ai] ${seoContent.titleRu?.slice(0, 40)} | category: ${categoryType} | structure: ${productStructure?.productType ?? 'null'} | queries: ${validatedQueries.length} | wbCoreQuery: ${wbCoreQuery}`);

    await supabase.from('jobs').update({
      status: 'ai_done',
      result_json: {
        ...(job.result_json as any),
        seoContent,
        productStructure,
        productLexicon,
        queryPlan,
        validatedQueries,
        wbCoreQuery,
        categoryType,
        intelligence,
      },
    }).eq('id', jobId);

    // Chain → step3-market
    const host = req.headers.host || 'card-zip.vercel.app';
    let sent = false;
    for (let i = 0; i < 2 && !sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step3-market`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
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
