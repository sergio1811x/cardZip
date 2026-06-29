import type { Context } from 'telegraf';
import { Input, Markup } from 'telegraf';
import AdmZip from 'adm-zip';
import { supabase } from '../../db/supabase';
import { buildEconomicsDetail, buildWbDetail, build1688Detail } from '../../core/messageBuilder';
import { buildCargoBrief, buildInfographicBrief, buildRiskChecklist, buildSampleRecommendation } from '../../core/decisionLayer';
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

function detailKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`), Markup.button.callback('📄 Файлы', `materials_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function safePrefix(product: any, offerId: string): string {
  return ((product?.titleRu ?? product?.title ?? '')
    .replace(/[^\w\sа-яёА-ЯЁ-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('_')
    .substring(0, 40) || offerId).replace(/_+/g, '_');
}

function buildMaterials(job: any): { product?: ProductWithContent; prefix: string; docs: Array<{ filename: string; text: string; title: string; description: string }>; imageUrls: string[] } {
  const result = job.result_json as any;
  const product = result?.product as ProductWithContent | undefined;
  const generatedFiles = result?.generatedFiles ?? {};
  const offerId = product?.productId?.slice(-8) ?? Date.now().toString().slice(-8);
  const prefix = `${safePrefix(product, offerId)}_${offerId}`;
  const safeFlags = (product?.riskFlags ?? {}) as any;

  const seoText = generatedFiles?.seoText ?? (product ? formatSeoText(product, product.seoContent ?? {}, safeFlags) : '');
  const briefText = generatedFiles?.briefText ?? (product ? formatOrderBrief(product, product.seoContent ?? {}, product.economics, safeFlags, job.input_url, product.budgets, product.conclusion) : '');
  const supplierText = generatedFiles?.supplierQuestions ?? generatedFiles?.supplierText ?? '';
  const cargoText = generatedFiles?.cargoText ?? (product ? buildCargoBrief(product, job.input_url) : '');
  const infographicText = generatedFiles?.infographicText ?? (product ? buildInfographicBrief(product) : '');
  const riskChecklistText = generatedFiles?.riskChecklistText ?? (product ? buildRiskChecklist(product) : '');
  const sampleRecommendationText = generatedFiles?.sampleRecommendationText ?? (product ? buildSampleRecommendation(product) : '');

  const docs = [
    { filename: `questions_ru_cn_${prefix}.txt`, text: String(supplierText || 'Вопросы поставщику не найдены. Откройте кнопку “Поставщику”.'), title: '💬 questions_ru_cn.txt', description: 'Вопросы поставщику на русском и китайском.' },
    { filename: `buyer_brief_${prefix}.md`, text: String(briefText), title: '📄 buyer_brief.md', description: 'ТЗ байеру: что закупаем, SKU, цена, риски, что проверить.' },
    { filename: `cargo_brief_${prefix}.md`, text: String(cargoText), title: '🚚 cargo_brief.md', description: 'ТЗ карго: вес, габариты, упаковка, ограничения.' },
    { filename: `risk_checklist_${prefix}.md`, text: String(riskChecklistText), title: '⚠️ risk_checklist.md', description: 'Что проверить до образца, на образце и перед партией.' },
    { filename: `sample_plan_${prefix}.md`, text: String(sampleRecommendationText), title: '🧪 sample_plan.md', description: 'Какой образец взять и что проверить.' },
    { filename: `seo_draft_${prefix}.md`, text: String(seoText), title: '📝 seo_draft.md', description: 'Черновик карточки WB/Ozon.' },
    { filename: `infographic_brief_${prefix}.md`, text: String(infographicText), title: '🎨 infographic_brief.md', description: 'ТЗ для дизайнера инфографики.' },
  ].filter(d => d.text && d.text.trim().length > 0);

  return { product, prefix, docs, imageUrls: (result?.imageUrls ?? []) as string[] };
}

async function sendDocs(ctx: Context, chatId: number, docs: Array<{ filename: string; text: string }>) {
  for (const doc of docs) {
    await ctx.telegram.sendDocument(chatId, Input.fromBuffer(Buffer.from(doc.text, 'utf-8'), doc.filename)).catch(() => {});
  }
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
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });
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
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });
}

export async function handleProductDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^product_detail_(.+)$/);
  if (!match) return;

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();
  const { text, keyboard } = build1688Detail(product, jobId);
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });
}

export async function handleRiskDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^risk_detail_(.+)$/);
  if (!match) return;
  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) return void await ctx.answerCbQuery('Данные недоступны');
  await ctx.answerCbQuery();
  await ctx.reply(buildRiskChecklist(product), { link_preview_options: { is_disabled: true }, ...detailKeyboard(jobId) });
}

export async function handleSampleDetail(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^sample_detail_(.+)$/);
  if (!match) return;
  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) return void await ctx.answerCbQuery('Данные недоступны');
  await ctx.answerCbQuery();
  await ctx.reply(buildSampleRecommendation(product), { link_preview_options: { is_disabled: true }, ...detailKeyboard(jobId) });
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

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны');
    return;
  }

  await ctx.answerCbQuery();
  const { docs, imageUrls } = buildMaterials(job);
  const preview = ['📄 <b>Закупочный пакет готов</b>', '', `Я подготовил ${docs.length} материалов:`, '',
    ...docs.map((d, i) => `${i + 1}. ${d.title}\n   ${d.description}`),
    ...(imageUrls.length ? ['', '8. 📷 photos.zip\n   Фото товара с 1688.'] : []),
    '', 'Скачать всё одним ZIP?'].join('\n');
  await ctx.reply(preview, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('⬇️ Скачать ZIP', `materials_zip_${jobId}`)],
      [Markup.button.callback('📄 Скачать по отдельности', `materials_list_${jobId}`)],
      [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`)],
    ]),
  });
}

export async function handleMaterialsZip(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_zip_(.+)$/);
  if (!match) return;
  const job = await getJobData(ctx, match[1]);
  if (!job) return void await ctx.answerCbQuery('Данные недоступны');
  await ctx.answerCbQuery('Собираю ZIP');
  const { docs, prefix, imageUrls } = buildMaterials(job);
  const zip = new AdmZip();
  for (const doc of docs) zip.addFile(doc.filename, Buffer.from(doc.text, 'utf-8'));
  zip.addFile('README.txt', Buffer.from('CardZip: закупочный пакет товара с 1688. Документы являются черновиками и требуют проверки веса, SKU, упаковки и образца.\n', 'utf-8'));
  await ctx.telegram.sendDocument(ctx.chat!.id, Input.fromBuffer(zip.toBuffer(), `CardZip_закупочный_пакет_${prefix}.zip`)).catch(() => {});
  if (imageUrls?.length) {
    const imgZip = await zipBuilder.buildFromUrls(imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null);
    if (imgZip) await ctx.telegram.sendDocument(ctx.chat!.id, Input.fromBuffer(imgZip, `Фото_1688_${prefix}.zip`)).catch(() => {});
  }
}

export async function handleMaterialsList(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_list_(.+)$/);
  if (!match) return;
  const job = await getJobData(ctx, match[1]);
  if (!job) return void await ctx.answerCbQuery('Данные недоступны');
  await ctx.answerCbQuery('Отправляю файлы');
  const { docs, imageUrls, prefix } = buildMaterials(job);
  await sendDocs(ctx, ctx.chat!.id, docs);
  if (imageUrls?.length) {
    const imgZip = await zipBuilder.buildFromUrls(imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null);
    if (imgZip) await ctx.telegram.sendDocument(ctx.chat!.id, Input.fromBuffer(imgZip, `Фото_1688_${prefix}.zip`)).catch(() => {});
  }
}
