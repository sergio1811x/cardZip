import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { calcEconomics, calcBudgetScenarios, calcMaxPurchasePrice } from '../src/core/economicsCalc';
import { buildConclusion } from '../src/core/verdict';
import { buildRiskFlags } from '../src/core/riskFlags';
import { filterWbData } from '../src/core/wbFilter';
import { createStepProgress } from '../src/core/progress';
import { getUserTariffs } from '../src/db/queries/userSettings';
import type { WbFilterKeywords, WbCard } from '../src/types';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

// ─── Text Search API (быстрый, стабильный, с Vercel) ─────────────────────────

async function searchWbByText(query: string) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&query=${encoded}&resultset=catalog&sort=popular&spp=30`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const products = data?.products ?? [];
    if (!products.length) return null;

    const cards: WbCard[] = products.slice(0, 50).map((p: any) => ({
      title: p.name || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : 0,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    })).filter((c: WbCard) => c.price > 0);

    if (!cards.length) return null;

    const prices = cards.map(c => c.price);
    return {
      avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      totalCards: products.length,
      topExamples: cards.slice(0, 3),
      allCards: cards,
      photoSearchConfirmed: false,
    };
  } catch (e: any) {
    console.warn('[wb-text] Search failed:', e.message);
    return null;
  }
}

// ─── Photo Search via VPS (медленный, visual match) ──────────────────────────

async function searchWbByPhoto(imageUrl: string) {
  try {
    const params = new URLSearchParams({ secret: WB_PARSER_SECRET, limit: '50', image_url: imageUrl });
    const url = `${WB_PARSER_URL}/search-by-image?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.success || !data.products?.length) return null;

    const cards: WbCard[] = data.products.filter((p: any) => p.price > 0).map((p: any) => ({
      title: p.name || '',
      price: p.price,
      url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      rating: p.rating || p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    }));

    if (!cards.length) return null;
    const prices = cards.map(c => c.price);
    return {
      avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      totalCards: data.total || cards.length,
      topExamples: cards.slice(0, 3),
      allCards: cards,
      photoSearchConfirmed: data.photoSearchConfirmed ?? true,
    };
  } catch (e: any) {
    console.warn('[wb-photo] VPS failed:', e.message);
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

    // ─── ПАРАЛЛЕЛЬНЫЙ ПОИСК: Text API (2с) + Photo VPS (30с) ─────────────
    const textQuery = seoContent?.keywords?.[0] ?? seoContent?.titleRu ?? raw.titleEn ?? raw.titleCn;
    const photoUrl = raw.mainImageUrl;

    console.log(`[step3] Parallel search: text="${textQuery?.slice(0, 30)}" + photo=${photoUrl ? 'yes' : 'no'}`);

    const [textResult, photoResult] = await Promise.all([
      searchWbByText(textQuery),
      photoUrl ? searchWbByPhoto(photoUrl) : Promise.resolve(null),
    ]);

    // Приоритет: photo (visual match) > text (keyword match)
    const wbData = (photoResult && photoResult.allCards.length >= 5) ? photoResult
      : (textResult && textResult.allCards.length > (photoResult?.allCards.length ?? 0)) ? textResult
      : photoResult ?? textResult;

    const searchSource = wbData === photoResult ? 'photo' : wbData === textResult ? 'text' : 'none';
    console.log(`[step3] WB source: ${searchSource} | photo: ${photoResult?.allCards.length ?? 0} cards | text: ${textResult?.allCards.length ?? 0} cards`);

    // Фильтрация
    const filterKeywords = seoContent?.filterKeywords ?? DEFAULT_FILTER_KEYWORDS;
    const searchQueries = seoContent?.searchQueries ?? seoContent?.keywords?.slice(0, 3) ?? [];
    const wbFiltered = filterWbData(wbData, filterKeywords, searchQueries);

    // Тарифы
    const userTariffs = await getUserTariffs(job.user_id).catch(() => null);

    // Экономика
    const economics = await calcEconomics({
      platform: raw.platform,
      priceYuan: raw.priceYuan,
      weightKg: raw.weightKg,
      categoryHint: raw.categoryName,
      tariffs: userTariffs ?? undefined,
      ...(wbFiltered && wbFiltered.medianPrice > 0 ? { wbMedianPrice: wbFiltered.medianPrice } : {}),
    });

    const riskFlags = buildRiskFlags(raw, wbFiltered);
    const budgets = calcBudgetScenarios(economics.costRub, economics.weightMissing, raw.moq);
    const maxPurchasePrice = wbFiltered?.medianPrice
      ? calcMaxPurchasePrice(wbFiltered.medianPrice, raw.weightKg, economics.yuanToRub, userTariffs ?? undefined, raw.priceYuan)
      : null;
    const conclusion = buildConclusion(raw.platform, economics, wbFiltered, riskFlags);

    progress?.stop();

    console.log(`[step3] WB: ${wbFiltered?.quality ?? 'null'} (${wbFiltered?.relevantCount ?? 0} relevant) | ${conclusion.icon} ${conclusion.headline.slice(0, 40)}`);

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
          budgets,
          maxPurchasePrice,
          conclusion,
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
      console.error(`[step3] Failed to trigger step4 for job ${jobId}`);
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
    console.error('[step3]', e.message);
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
    res.status(200).json({ ok: false });
  }
}
