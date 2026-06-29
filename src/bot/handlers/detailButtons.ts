import type { Context } from 'telegraf';
import { Input, Markup } from 'telegraf';
import AdmZip from 'adm-zip';
import { supabase } from '../../db/supabase';
import { buildEconomicsDetail, buildWbDetail, build1688Detail, buildProcurementPlanDetail } from '../../core/messageBuilder';
import { buildCargoBrief, buildInfographicBrief, buildRiskChecklist, buildSampleRecommendation, buildSupplierQuestions } from '../../core/decisionLayer';
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
    [Markup.button.callback('⬅️ Назад к плану', `proc_plan_${jobId}`)],
    [Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`), Markup.button.callback('📁 Материалы', `materials_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function materialsKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💬 Вопросы поставщику', `materials_group_questions_${jobId}`)],
    [Markup.button.callback('📄 Для байера', `materials_group_buyer_${jobId}`), Markup.button.callback('🚚 Для карго', `materials_group_cargo_${jobId}`)],
    [Markup.button.callback('🧪 Образец и риски', `materials_group_check_${jobId}`), Markup.button.callback('📝 Для карточки', `materials_group_card_${jobId}`)],
    [Markup.button.callback('⬇️ Скачать всё ZIP', `materials_zip_${jobId}`)],
    [Markup.button.callback('⬅️ Назад к плану', `proc_plan_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
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

  // Build materials from the current product state so supplier replies/manual weight
  // immediately update buyer/cargo/risk/sample docs instead of showing stale files.
  const seoText = product ? formatSeoText(product, product.seoContent ?? {}, safeFlags) : (generatedFiles?.seoText ?? '');
  const briefText = product ? formatOrderBrief(product, product.seoContent ?? {}, product.economics, safeFlags, job.input_url, product.budgets, product.conclusion) : (generatedFiles?.briefText ?? '');
  const supplierText = product
    ? ['# Вопросы поставщику', '', '## Русская версия', ...buildSupplierQuestions(product).ru.map((q, i) => `${i + 1}. ${q}`), '', '## Китайская версия', ...buildSupplierQuestions(product).cn.map((q, i) => `${i + 1}. ${q}`)].join('\n')
    : (generatedFiles?.supplierQuestions ?? generatedFiles?.supplierText ?? '');
  const cargoText = product ? buildCargoBrief(product, job.input_url) : (generatedFiles?.cargoText ?? '');
  const infographicText = product ? buildInfographicBrief(product) : (generatedFiles?.infographicText ?? '');
  const riskChecklistText = product ? buildRiskChecklist(product) : (generatedFiles?.riskChecklistText ?? '');
  const sampleRecommendationText = product ? buildSampleRecommendation(product) : (generatedFiles?.sampleRecommendationText ?? '');

  const docs = [
    { filename: `questions_ru_cn_${prefix}.txt`, text: String(supplierText || 'Вопросы поставщику не найдены. Откройте кнопку “Текст поставщику”.'), title: '💬 questions_ru_cn.txt', description: 'Вопросы поставщику на русском и китайском.' },
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

export async function handleProcurementPlan(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^proc_plan_(.+)$/);
  if (!match) return;
  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) return void await ctx.answerCbQuery('Данные недоступны');
  await ctx.answerCbQuery();
  const { text, keyboard } = buildProcurementPlanDetail(product, jobId);
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });
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
  const preview = [
    '📁 <b>Закупочный пакет</b>',
    '',
    'Я подготовил материалы по этапам.',
    '',
    '1. <b>Для поставщика</b>',
    '💬 Вопросы RU/CN — нужно отправить сейчас.',
    '',
    '2. <b>Для байера</b>',
    '📄 ТЗ байеру — что закупаем, SKU, цена, что проверить.',
    '',
    '3. <b>Для карго</b>',
    '🚚 ТЗ карго — вес, габариты, упаковка, ограничения.',
    '',
    '4. <b>Для проверки товара</b>',
    '⚠️ Риск-чеклист',
    '🧪 План образца',
    '',
    '5. <b>Для карточки</b>',
    '📝 SEO-черновик',
    '🎨 ТЗ для инфографики',
    ...(imageUrls.length ? ['', '📷 Фото товара доступны отдельным архивом после скачивания ZIP.'] : []),
    '',
    'Рекомендация: сначала используйте «Вопросы поставщику». Остальные документы лучше скачивать после ответа поставщика.',
    '',
    `Всего документов: ${docs.length}`,
  ].join('\n');
  await ctx.reply(preview, {
    parse_mode: 'HTML',
    ...materialsKeyboard(jobId),
  });
}

export async function handleMaterialsGroup(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_group_(questions|buyer|cargo|check|card)_(.+)$/);
  if (!match) return;
  const [, group, jobId] = match;
  const job = await getJobData(ctx, jobId);
  if (!job) return void await ctx.answerCbQuery('Данные недоступны');
  const { docs } = buildMaterials(job);
  const selected = docs.filter((d) => {
    if (group === 'questions') return /questions/i.test(d.filename);
    if (group === 'buyer') return /buyer_brief/i.test(d.filename);
    if (group === 'cargo') return /cargo_brief/i.test(d.filename);
    if (group === 'check') return /risk_checklist|sample_plan/i.test(d.filename);
    if (group === 'card') return /seo_draft|infographic_brief/i.test(d.filename);
    return false;
  });
  await ctx.answerCbQuery(selected.length ? 'Отправляю материалы' : 'Материалы не найдены');
  if (!selected.length) return;
  await sendDocs(ctx, ctx.chat!.id, selected);
  await ctx.reply('Готово. Можно вернуться к плану или скачать весь закупочный пакет.', materialsKeyboard(jobId)).catch(() => {});
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
  await ctx.reply('ZIP отправлен. Дальше лучше внести ответ поставщика и обновить пакет.', materialsKeyboard(match[1])).catch(() => {});
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
