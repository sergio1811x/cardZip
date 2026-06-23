import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { aiContentGenerator } from '../src/providers/aiContentGenerator';
import { calcEconomics } from '../src/core/economicsCalc';
import { buildVerdict } from '../src/core/verdict';
import { createStepProgress } from '../src/core/progress';

export const config = { maxDuration: 60 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

const WB_PARSER_URL = process.env.WB_PARSER_URL || 'http://50fc4ca33bd1.vps.myjino.ru';
const WB_PARSER_SECRET = process.env.WB_PARSER_SECRET || 'cardzip-wb-2024';

async function searchWbByImage(imageUrl: string) {
  try {
    const url = `${WB_PARSER_URL}/search-by-image?secret=${WB_PARSER_SECRET}&image_url=${encodeURIComponent(imageUrl)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (!data.success || !data.products?.length) return null;

    const prices = data.products.map((p: any) => p.price).filter((p: number) => p > 0);
    if (!prices.length) return null;

    return {
      avgPrice: Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length),
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      totalCards: data.total || data.products.length,
      topExamples: data.products.filter((p: any) => p.price > 0).slice(0, 3).map((p: any) => ({
        title: p.name || '', price: p.price,
        url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      })),
    };
  } catch (e: any) {
    console.warn('[step2] WB failed:', e.message);
    return null;
  }
}

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

    // Прогресс с анимацией
    const progress = job.tg_message_id
      ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'process')
      : null;

    // Параллельно: AI + WB + экономика
    const [seoContent, wbData, economics] = await Promise.all([
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
      }).catch(() => ({
        titleRu: raw.titleEn || raw.titleCn,
        description: '', bullets: [] as string[], keywords: [] as string[],
        characteristics: {} as Record<string, string>, isFallback: true,
      })),

      searchWbByImage(raw.mainImageUrl),

      calcEconomics({ priceYuan: raw.priceYuan, weightKg: raw.weightKg }),
    ]);

    // Пересчитаем экономику с ценой WB
    const finalEconomics = wbData?.avgPrice
      ? await calcEconomics({ priceYuan: raw.priceYuan, weightKg: raw.weightKg, wbAvgPrice: wbData.avgPrice })
      : economics;

    progress?.stop();
    const verdict = buildVerdict(finalEconomics, wbData, raw.sold);

    console.log(`[step2] AI: ${seoContent.titleRu?.slice(0, 30)} | WB: ${wbData ? wbData.totalCards + ' cards' : 'null'}`);

    // Сохраняем результат
    await supabase.from('jobs').update({
      status: 'done',
      result_json: {
        ...(job.result_json as any),
        product: {
          ...raw,
          titleRu: seoContent.titleRu,
          seoContent,
          wbData,
          economics: finalEconomics,
          verdict,
        },
      },
      finished_at: new Date().toISOString(),
    }).eq('id', jobId);

    // Вызываем step3
    const host = req.headers.host || 'card-zip.vercel.app';
    fetch(`https://${host}/api/step3-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }).catch(() => {});

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[step2]', e.message);
    await supabase.from('jobs').update({ status: 'failed', error: e.message, finished_at: new Date().toISOString() }).eq('id', jobId);
    res.status(200).json({ ok: false });
  }
}
