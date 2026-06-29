import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { supabase } from '../src/db/supabase';
import { createStepProgress } from '../src/core/progress';
import { acquireStepLock, extendProcessingLock } from '../src/lib/stepLock';
import { buildDecisionContext } from '../src/core/decisionLayer';

export const config = { maxDuration: 30 };

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { jobId } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  try {
    const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
    if (!job || job.status !== 'ai_done') return res.status(200).json({ ok: true, skip: true });
    if (!await acquireStepLock('step3', jobId)) return res.status(200).json({ ok: true, skip: true });
    await extendProcessingLock(job.user_id);

    await supabase.from('jobs').update({ status: 'package_processing', updated_at: new Date().toISOString() }).eq('id', jobId);

    const result = job.result_json as any;
    const raw = result.rawProduct;
    const seoContent = result.seoContent ?? {};
    const product = {
      ...raw,
      titleRu: seoContent.titleRu ?? result.productIntelligence?.cleanTitles?.titleForReport ?? raw?.titleEn ?? raw?.titleCn,
      seoContent,
      intelligence: result.productIntelligence ?? result.intelligence,
      productContext: result.productContext,
      wbData: null,
      wbFiltered: null,
      wbTrends: [],
      marketDecision: {
        status: 'not_required',
        rawCandidatesCount: 0,
        confirmedDirectCount: 0,
        similarLocalCount: 0,
        crossBorderCount: 0,
        categoryOnlyCount: 0,
        medianPriceRub: null,
        p25PriceRub: null,
        p75PriceRub: null,
        canShowMedianPrice: false,
        canCalculateRoi: false,
        confidence: 'low',
        reason: 'WB/Ozon не используется как обязательный источник. Рынок проверяется вручную.',
      },
      economics: {
        yuanToRub: 11.8,
        status: 'cost_only',
        canShowRoi: false,
        isSyntheticPrice: false,
      },
      riskFlags: {
        weightMissing: !raw?.weightKg,
        marketDataUnreliable: true,
      },
      conclusion: {
        platform: raw?.platform ?? '1688',
        icon: '🟡',
        headline: 'Закупочная гипотеза без автоматической проверки WB/Ozon',
        disclaimers: ['ROI не считается автоматически без ручной цены продажи или конкурентов.'],
      },
    };
    const decision = buildDecisionContext(product);

    const progress = job.tg_message_id ? createStepProgress(bot, job.tg_chat_id, job.tg_message_id, 'market') : null;
    progress?.stop();

    await supabase.from('jobs').update({
      status: 'done',
      result_json: {
        ...result,
        product,
        decisionContext: {
          price: decision.price,
          sku: decision.sku,
          weight: decision.weight,
          readiness: decision.readiness,
          cost: decision.cost,
        },
        noWbMvp: true,
        noWbReason: 'MVP работает как закупочный пакет без обязательного WB-парсинга.',
        durationMarketMs: 0,
      },
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);

    const host = req.headers.host || 'card-zip.vercel.app';
    for (let i = 0; i < 2; i++) {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 4000);
        await fetch(`https://${host}/api/step4-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
          signal: ac.signal,
        });
        break;
      } catch (e: any) {
        console.warn(`[step3] step4 chain attempt ${i + 1} failed: ${e.message}`);
        if (i === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    res.status(200).json({ ok: true, noWbMvp: true });
  } catch (e: any) {
    console.error('[step3]', e.message);
    const { handleStepError } = require('../src/lib/stepError');
    await handleStepError(jobId, e.message, bot);
    res.status(200).json({ ok: false });
  }
}
