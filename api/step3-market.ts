import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { calcEconomics, calcTestPurchase } from '../src/core/economicsCalc';
import { buildVerdict } from '../src/core/verdict';
import { buildRiskFlags } from '../src/core/riskFlags';
import { filterWbData } from '../src/core/wbFilter';
import { createStepProgress } from '../src/core/progress';
import { getUserTariffs } from '../src/db/queries/userSettings';
import type { WbFilterKeywords } from '../src/types';

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
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.success || !data.products?.length) return null;

    const cards = data.products.filter((p: any) => p.price > 0).map((p: any) => ({
      title: p.name || '',
      price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      rating: p.rating || p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
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
    console.warn('[step3-market] WB failed:', e.message);
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
    if (!job || job.status !== 'ai_done') return res.status(200).json({ ok: true, skip: true });

    await supabase.from('jobs').update({ status: 'market_processing' }).eq('id', jobId);

    const raw = (job.result_json as any).rawProduct;
    const seoContent = (job.result_json as any).seoContent;

    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'market')
      : null;

    // WB поиск — полные 45с, функция своя
    const wbQuery = raw.titleEn || raw.titleCn;
    const wbData = await searchWbByImage(raw.mainImageUrl, wbQuery);

    // Фильтрация
    const filterKeywords = seoContent?.filterKeywords ?? DEFAULT_FILTER_KEYWORDS;
    const searchQueries = seoContent?.searchQueries ?? seoContent?.keywords?.slice(0, 3) ?? [];
    const wbFiltered = filterWbData(wbData, filterKeywords, searchQueries);

    // Пользовательские тарифы
    const userTariffs = await getUserTariffs(job.user_id).catch(() => null);

    // Экономика
    const economicsInput = {
      priceYuan: raw.priceYuan,
      weightKg: raw.weightKg,
      categoryHint: raw.categoryName,
      tariffs: userTariffs ?? undefined,
      ...(wbFiltered && wbFiltered.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    };
    const economics = await calcEconomics(economicsInput);

    const riskFlags = buildRiskFlags(raw, wbFiltered);
    const testPurchase = calcTestPurchase(economics.costRub, economics.weightMissing, raw.moq);
    const { score, verdict } = buildVerdict(economics, wbFiltered, riskFlags);

    progress?.stop();

    console.log(`[step3-market] WB: ${wbFiltered?.quality ?? 'null'} (${wbFiltered?.relevantCount ?? 0} relevant) | score: ${score.total}/100 | verdict: ${verdict.verdict}`);

    await supabase.from('jobs').update({
      status: 'done',
      result_json: {
        ...(job.result_json as any),
        product: {
          ...raw,
          titleRu: seoContent?.titleRu ?? raw.titleEn ?? raw.titleCn,
          seoContent,
          wbData,
          wbFiltered,
          riskFlags,
          economics,
          testPurchase,
          score,
          verdict,
        },
      },
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    // Chain → step4-send
    const host = req.headers.host || 'card-zip.vercel.app';
    let sent = false;
    for (let i = 0; i < 2 && !sent; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step4-send`, {
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
      console.error(`[step3-market] Failed to trigger step4-send for job ${jobId}`);
      if (job.tg_message_id) {
        await bot.telegram.editMessageText(
          job.tg_chat_id, job.tg_message_id, undefined,
          '❌ Не удалось отправить результат. Попробуйте ещё раз.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step3-market]', e.message);
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
    res.status(200).json({ ok: false });
  }
}
