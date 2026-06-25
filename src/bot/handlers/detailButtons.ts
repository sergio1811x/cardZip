import type { Context } from 'telegraf';
import { Input } from 'telegraf';
import { supabase } from '../../db/supabase';
import { buildEconomicsDetail, buildWbDetail } from '../../core/messageBuilder';
import { formatSeoText } from '../../core/seoFormatter';
import { formatOrderBrief } from '../../core/orderBrief';
import { zipBuilder } from '../../core/zipBuilder';
import type { ProductWithContent } from '../../types';

async function getJobData(ctx: Context, jobId: string): Promise<any | null> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return null;

  const { data: job } = await supabase
    .from('jobs')
    .select('result_json, input_url')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

  return job ?? null;
}

export async function handleEconDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^econ_detail_(.+)$/);
  if (!match) return;

  const job = await getJobData(ctx, match[1]);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  const jobId = match[1];
  await ctx.answerCbQuery();
  const { text, keyboard } = buildEconomicsDetail(product, jobId);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
}

export async function handleWbDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^wb_detail_(.+)$/);
  if (!match) return;

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();
  const { text, keyboard } = buildWbDetail(product, jobId);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
}

export async function handleBackToMain(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^back_main_(.+)$/);
  if (!match) return;

  const job = await getJobData(ctx, match[1]);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
}

export async function handleMaterialsResend(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_(.+)$/);
  if (!match) return;

  const job = await getJobData(ctx, match[1]);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();

  const chatId = ctx.chat!.id;
  await ctx.telegram.sendMessage(chatId,
    '📎 <b>Файлы готовы</b>\n\n• SEO-карточка для WB\n• ТЗ байеру / карго\n• Фото товара',
    { parse_mode: 'HTML' }
  );

  const result = job.result_json as any;
  const product = result?.product as ProductWithContent | undefined;
  const generatedFiles = result?.generatedFiles;
  const prefix = product?.productId?.slice(-8) ?? Date.now().toString().slice(-8);

  // SEO-карточка
  if (generatedFiles?.seoText) {
    await ctx.telegram.sendDocument(chatId, Input.fromBuffer(
      Buffer.from(generatedFiles.seoText, 'utf-8'), `wb_card_${prefix}.md`
    )).catch(() => {});
  } else if (product?.seoContent) {
    const safeFlags = product.riskFlags ?? {} as any;
    const text = formatSeoText(product, product.seoContent, safeFlags);
    await ctx.telegram.sendDocument(chatId, Input.fromBuffer(
      Buffer.from(text, 'utf-8'), `wb_card_${prefix}.md`
    )).catch(() => {});
  }

  // ТЗ байеру
  if (generatedFiles?.briefText) {
    await ctx.telegram.sendDocument(chatId, Input.fromBuffer(
      Buffer.from(generatedFiles.briefText, 'utf-8'), `buyer_brief_${prefix}.md`
    )).catch(() => {});
  } else if (product?.seoContent && product?.economics) {
    const safeFlags = product.riskFlags ?? {} as any;
    const text = formatOrderBrief(product, product.seoContent, product.economics, safeFlags, job.input_url, product.budgets, product.conclusion);
    await ctx.telegram.sendDocument(chatId, Input.fromBuffer(
      Buffer.from(text, 'utf-8'), `buyer_brief_${prefix}.md`
    )).catch(() => {});
  }

  // Фото
  const imageUrls = result?.imageUrls as string[] | undefined;
  if (imageUrls?.length) {
    const zip = await zipBuilder.buildFromUrls(imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null);
    if (zip) {
      await ctx.telegram.sendDocument(chatId, Input.fromBuffer(zip, `photos_${prefix}.zip`)).catch(() => {});
    }
  }
}
