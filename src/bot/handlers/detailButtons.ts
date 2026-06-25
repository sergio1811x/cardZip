import type { Context } from 'telegraf';
import { supabase } from '../../db/supabase';
import { buildEconomicsDetail, buildWbDetail } from '../../core/messageBuilder';
import type { ProductWithContent } from '../../types';

async function getProductFromJob(ctx: Context, jobId: string): Promise<ProductWithContent | null> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return null;

  const { data: job } = await supabase
    .from('jobs')
    .select('result_json')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

  return (job?.result_json as any)?.product as ProductWithContent ?? null;
}

export async function handleEconDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^econ_detail_(.+)$/);
  if (!match) return;

  const product = await getProductFromJob(ctx, match[1]);
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();
  await ctx.reply(buildEconomicsDetail(product), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export async function handleWbDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^wb_detail_(.+)$/);
  if (!match) return;

  const product = await getProductFromJob(ctx, match[1]);
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();
  await ctx.reply(buildWbDetail(product), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export async function handleMaterialsResend(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_(.+)$/);
  if (!match) return;

  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  const { data: job } = await supabase
    .from('jobs')
    .select('telegram_file_ids')
    .eq('id', match[1])
    .eq('user_id', userId)
    .single();

  if (!job?.telegram_file_ids) {
    await ctx.answerCbQuery('Файлы недоступны');
    return;
  }

  await ctx.answerCbQuery('Отправляю файлы...');

  const chatId = ctx.chat!.id;
  const fids = job.telegram_file_ids as any;

  if (fids.wb_card) await ctx.telegram.sendDocument(chatId, fids.wb_card).catch(() => {});
  if (fids.buyer_brief) await ctx.telegram.sendDocument(chatId, fids.buyer_brief).catch(() => {});
  if (fids.photos_zip) await ctx.telegram.sendDocument(chatId, fids.photos_zip).catch(() => {});
}
