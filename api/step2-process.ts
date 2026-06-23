import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { aiContentGenerator } from '../src/providers/aiContentGenerator';
import { calcEconomics, calcTestPurchase } from '../src/core/economicsCalc';
import { buildVerdict } from '../src/core/verdict';
import { buildRiskFlags } from '../src/core/riskFlags';
import { filterWbData } from '../src/core/wbFilter';
import { createStepProgress } from '../src/core/progress';
import type { AiContentResult, WbFilterKeywords } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

async function searchWbByImage(imageUrl: string, query?: string) {
  try {
    const params = new URLSearchParams({ secret: WB_PARSER_SECRET, limit: '50' });
    if (imageUrl) params.set('image_url', imageUrl);
    if (query) params.set('query', query);

    const url = `${WB_PARSER_URL}/search-by-image?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(50_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.success || !data.products?.length) return null;

    const cards = data.products.filter((p: any) => p.price > 0).map((p: any) => ({
      title: p.name || '',
      price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
    }));

    const prices = cards.map((c: any) => c.price);
    if (!prices.length) return null;

    return {
      avgPrice: Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length),
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      totalCards: data.total || data.products.length,
      topExamples: cards.slice(0, 3),
      allCards: cards,
      photoSearchConfirmed: data.photoSearchConfirmed ?? false,
    };
  } catch (e: any) {
    console.warn('[step2] WB failed:', e.message);
    return null;
  }
}

const DEFAULT_FILTER_KEYWORDS: WbFilterKeywords = { required: [], optional: [], exclude: [] };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'elim_done') return res.status(200).json({ ok: true, skip: true });

    await supabase.from('jobs').update({ status: 'processing' }).eq('id', jobId);

    const raw = (job.result_json as any).rawProduct;
    const imageUrls = (job.result_json as any).imageUrls;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'process')
      : null;

    const wbQuery = raw.titleEn || raw.titleCn;

    const [seoContent, wbData, initialEconomics] = await Promise.all([
      aiContentGenerator.generate({
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
      })),

      searchWbByImage(raw.mainImageUrl, wbQuery),

      calcEconomics({ priceYuan: raw.priceYuan, weightKg: raw.weightKg }),
    ]);

    // Фильтрация WB
    const filterKeywords = seoContent.filterKeywords ?? DEFAULT_FILTER_KEYWORDS;
    const searchQueries = seoContent.searchQueries ?? seoContent.keywords?.slice(0, 3) ?? [];
    const wbFiltered = filterWbData(wbData, filterKeywords, searchQueries);

    // Пересчёт экономики с медианой
    const economics = wbFiltered && wbFiltered.medianPrice > 0
      ? await calcEconomics({ priceYuan: raw.priceYuan, weightKg: raw.weightKg, wbMedianPrice: wbFiltered.medianPrice })
      : initialEconomics;

    const riskFlags = buildRiskFlags(raw, wbFiltered);
    const testPurchase = calcTestPurchase(economics.costRub, economics.weightMissing);

    progress?.stop();
    const verdict = buildVerdict(economics, wbFiltered, riskFlags);

    console.log(`[step2] AI: ${seoContent.titleRu?.slice(0, 30)} | WB: ${wbFiltered?.quality ?? 'null'} (${wbFiltered?.relevantCount ?? 0} relevant)`);

    await supabase.from('jobs').update({
      status: 'done',
      result_json: {
        ...(job.result_json as any),
        product: {
          ...raw,
          titleRu: seoContent.titleRu,
          seoContent,
          wbData,
          wbFiltered,
          riskFlags,
          economics,
          testPurchase,
          verdict,
        },
      },
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    res.status(200).json({ ok: true });
    const host = req.headers.host || 'card-zip.vercel.app';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1000);
    await fetch(`https://${host}/api/step3-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
      signal: ac.signal,
    }).catch(() => {});
    return;
  } catch (e: any) {
    console.error('[step2]', e.message);
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
    res.status(200).json({ ok: false });
  }
}
