import type { Context } from 'telegraf';
import { Input, Markup } from 'telegraf';
import AdmZip from 'adm-zip';
import { supabase } from '../../db/supabase';
import { buildEconomicsDetail, buildWbDetail, build1688Detail, buildProcurementPlanDetail, buildMainMessage } from '../../core/messageBuilder';
import { buildInfographicBrief, buildRiskChecklist, buildSampleRecommendation, buildDecisionContext, validateGeneratedText } from '../../core/decisionLayer';
import { buildSupplierQuestionsFromProfile, buildBuyerBriefFromProfile, buildCargoBriefFromProfile, buildSampleChecklistFromProfile, buildSeoDraftFromProfile, buildReadmeFromProfile, validateDocuments, ensureProductProcurementProfile } from '../../core/procurementProfile';
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
    [Markup.button.callback('⬅️ Назад', `back_main:${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main:${jobId}`)],
    [Markup.button.callback('📁 Закупочный пакет', `package:${jobId}`), Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function materialsKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬇️ Скачать ZIP', `package_zip:${jobId}`)],
    [Markup.button.callback('💬 Вопросы поставщику', `supplier_questions:${jobId}`), Markup.button.callback('📦 Данные товара', `product_details:${jobId}`)],
    [Markup.button.callback('⬅️ Назад', `back_main:${jobId}`)],
  ]);
}

function groupBackKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Назад', `package:${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main:${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function safeSectionErrorKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏠 К отчёту', `back_main:${jobId}`), Markup.button.callback('📁 Закупочный пакет', `package:${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

async function replySectionError(ctx: Context, jobId: string, action: string, error?: unknown) {
  console.error('[ui-handler-error]', {
    action,
    userId: (ctx as any).dbUserId,
    productId: jobId,
    state: (ctx as any).session?.procurementStatus,
    error,
  });
  const text = [
    '⚠️ <b>Не удалось открыть раздел.</b>',
    '',
    'Данные анализа сохранены.',
    'Попробуйте вернуться к отчёту или открыть пакет ещё раз.',
  ].join('\n');
  await ctx.reply(text, { parse_mode: 'HTML', ...safeSectionErrorKeyboard(jobId) }).catch(() => {});
}


function safePrefix(product: any, offerId: string): string {
  const raw = String(product?.titleEn ?? product?.titleRu ?? product?.title ?? offerId);
  const translit: Record<string, string> = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'
  };
  const slug = raw.toLowerCase().split('').map(ch => translit[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .slice(0, 5)
    .join('_')
    .slice(0, 48);
  return slug || offerId;
}



function cleanDoc(product: any, text: string, reportType: 'seo' | 'buyerBrief' | 'supplierQuestions' | 'main' = 'buyerBrief'): string {
  const x = buildDecisionContext(product ?? {});
  const checked = validateGeneratedText({
    productIntelligence: x.intelligence,
    generatedText: String(text ?? ''),
    reportType,
    categoryType: x.categoryType,
    marketDecision: x.market,
    weightDecision: x.weight,
  });
  return checked.fixedText || String(text ?? '').trim();
}

function cnBlockIsSafe(lines: string[]): boolean {
  const text = lines.join('\n');
  if (!text.trim()) return false;
  if (/[а-яё]/i.test(text)) return false;
  if (/file:\/\//i.test(text)) return false;
  if (/\b(?:размерная сетка|material|мощность|напряжение|подошва)\b/i.test(text)) return false;
  if (/\d+\.\s*\d+\./.test(text)) return false;
  return true;
}

function buildSupplierQuestionsText(product?: ProductWithContent): string {
  if (!product) return '# Вопросы поставщику\n\nРусская версия не найдена.';
  return buildSupplierQuestionsFromProfile(product).text;
}

function buildReadmeText(product: any, hasPhotos: boolean): string {
  const base = buildReadmeFromProfile(product);
  return hasPhotos ? base : `${base}\n\nФото не удалось скачать. Используйте фото из карточки 1688 вручную.\n`;
}

function buildMaterials(job: any): { product?: ProductWithContent; prefix: string; docs: Array<{ filename: string; text: string; title: string; description: string }>; imageUrls: string[] } {
  const result = job.result_json as any;
  const product = result?.product as ProductWithContent | undefined;
  const generatedFiles = result?.generatedFiles ?? {};
  const offerId = String(product?.productId ?? result?.offerId ?? job.id ?? Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(-12) || Date.now().toString().slice(-8);
  const prefix = `cardzip_${offerId}_${safePrefix(product, offerId)}`.replace(/_+/g, '_').replace(/_$/g, '');
  const imageUrls = (result?.imageUrls ?? product?.imageUrls ?? product?.images ?? []) as string[];

  if (product) ensureProductProcurementProfile(product, { sourceUrl: job.input_url });
  const supplierText = product ? buildSupplierQuestionsText(product) : (generatedFiles?.supplierQuestions ?? generatedFiles?.supplierText ?? '');
  const buyerText = product ? buildBuyerBriefFromProfile(product, { sourceUrl: job.input_url }) : (generatedFiles?.briefText ?? '');
  const cargoText = product ? buildCargoBriefFromProfile(product, { sourceUrl: job.input_url }) : (generatedFiles?.cargoText ?? '');
  const sampleText = product ? buildSampleChecklistFromProfile(product, { sourceUrl: job.input_url }) : (generatedFiles?.sampleChecklistText ?? generatedFiles?.sampleRecommendationText ?? generatedFiles?.riskChecklistText ?? '');
  const seoText = product ? buildSeoDraftFromProfile(product, { sourceUrl: job.input_url }) : (generatedFiles?.seoText ?? '');
  const readmeText = product ? buildReadmeText(product, imageUrls.length > 0) : 'CardZip — закупочный пакет';

  let docs = [
    { filename: '01_Вопросы_поставщику.txt', text: String(supplierText), title: '💬 Вопросы поставщику — 01_Вопросы_поставщику.txt', description: 'Текст для чата 1688: цена, SKU, вес, упаковка, фото.' },
    { filename: '02_ТЗ_байеру.md', text: String(buyerText), title: '📄 ТЗ байеру — 02_ТЗ_байеру.md', description: 'Что закупаем, какой SKU выбран, что проверить перед заказом.' },
    { filename: '03_ТЗ_карго.md', text: String(cargoText), title: '🚚 ТЗ карго — 03_ТЗ_карго.md', description: 'Что запросить для расчёта доставки: вес, габариты, короб, ограничения.' },
    { filename: '04_Чеклист_образца.md', text: String(sampleText), title: '🧪 Чек-лист образца — 04_Чеклист_образца.md', description: 'Что проверить на образце перед партией.' },
    { filename: '05_SEO_черновик.md', text: String(seoText), title: '📝 SEO-черновик — 05_SEO_черновик.md', description: 'Название, описание, характеристики и идеи инфографики.' },
    { filename: '00_Инструкция.txt', text: readmeText, title: 'ℹ️ 00_Инструкция.txt', description: 'Что внутри пакета и порядок работы.' },
  ].filter(d => d.text && d.text.trim().length > 0);

  if (product) {
    const checked = validateDocuments(docs, ensureProductProcurementProfile(product, { sourceUrl: job.input_url }));
    if (checked.errors.length) console.warn('[materials-validator]', checked.errors.join('; '));
    docs = checked.fixedDocs.map((fixed) => ({ ...docs.find((d) => d.filename === fixed.filename)!, text: fixed.text }));
  }

  return { product, prefix, docs, imageUrls };
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
  const match = (ctx.callbackQuery as any)?.data?.match(/^product_details?[:_](.+)$/);
  if (!match) return;

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'product_detail:not_found');
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
  const match = (ctx.callbackQuery as any)?.data?.match(/^back_main[:_](.+)$/);
  if (!match) return;

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  const product = (job?.result_json as any)?.product as ProductWithContent | undefined;
  if (!product) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'back_main:not_found');
  }

  await ctx.answerCbQuery('Открываю отчёт').catch(() => {});
  const { text, keyboard } = buildMainMessage(product, jobId, {});
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard });
}

export async function handleMaterialsResend(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^(?:materials_|package:)(.+)$/);
  if (!match) return;

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'materials:not_found');
  }

  await ctx.answerCbQuery().catch(() => {});
  const { imageUrls } = buildMaterials(job);
  const preview = [
    '📁 <b>Закупочный пакет готов</b>',
    '',
    'Я собрал документы, которые можно передать поставщику, байеру и карго.',
    '',
    '<b>Что внутри:</b>',
    '',
    '💬 <b>Вопросы поставщику</b>',
    '01_Вопросы_поставщику.txt',
    'Текст для чата 1688: цена, SKU, вес, упаковка, фото.',
    '',
    '📄 <b>ТЗ байеру</b>',
    '02_ТЗ_байеру.md',
    'Что закупаем, какой SKU выбран, что проверить перед заказом.',
    '',
    '🚚 <b>ТЗ карго</b>',
    '03_ТЗ_карго.md',
    'Что запросить для расчёта доставки: вес, габариты, короб, ограничения.',
    '',
    '🧪 <b>Чек-лист образца</b>',
    '04_Чеклист_образца.md',
    'Что проверить на образце перед партией.',
    '',
    '📝 <b>SEO-черновик</b>',
    '05_SEO_черновик.md',
    'Название, описание, характеристики и идеи инфографики.',
    '',
    '📷 <b>Фото товара</b>',
    '06_Фото_товара.zip',
    imageUrls.length ? 'Фото из карточки 1688.' : 'Фото не удалось скачать автоматически — используйте карточку 1688 вручную.',
    '',
    '<b>Что сделать сейчас:</b>',
    '1. Откройте «Вопросы поставщику».',
    '2. Отправьте текст в чат 1688.',
    '3. После ответа используйте ТЗ байеру и карго.',
  ].join('\n');
  await ctx.reply(preview, {
    parse_mode: 'HTML',
    ...materialsKeyboard(jobId),
  });
}

export async function handleMaterialsInside(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_inside[:_](.+)$/);
  if (!match) return;
  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'materials_inside:not_found');
  }
  await ctx.answerCbQuery('Открываю состав пакета').catch(() => {});
  const { docs, imageUrls } = buildMaterials(job);
  const lines = [
    '📄 <b>Что внутри закупочного пакета</b>',
    '',
    ...docs.map(d => `${d.title}\n${d.description}`),
    '',
    imageUrls.length ? '📷 06_Фото_товара.zip\nФото товара с 1688 будут внутри ZIP.' : '📷 06_Фото_товара.zip\nФото не удалось получить автоматически. Используйте фото из карточки 1688 вручную.',
    '',
    '<b>Что делать сейчас:</b>',
    'отправьте 01_Вопросы_поставщику.txt поставщику, затем используйте 02_ТЗ_байеру.md и 03_ТЗ_карго.md для команды.',
  ];
  await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML', ...groupBackKeyboard(jobId) });
}

// Legacy group callback kept for old inline buttons. It no longer exposes removed MVP documents.
export async function handleMaterialsGroup(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_group[:_](questions|buyer_cargo|check|card)[:_](.+)$/);
  if (!match) return;
  const jobId = match[2];
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('📁 <b>Закупочный пакет</b>\n\nВ новом MVP отдельные группы убраны. Откройте состав пакета или скачайте ZIP.', { parse_mode: 'HTML', ...materialsKeyboard(jobId) });
}

export async function handleMaterialsDoc(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_doc[:_](questions|buyer|cargo|sample|seo|readme)[:_](.+)$/);
  if (!match) return;
  const [, type, jobId] = match;
  const job = await getJobData(ctx, jobId);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'materials_doc:not_found');
  }
  const { docs } = buildMaterials(job);
  const selected = docs.find((d) => {
    if (type === 'questions') return d.filename === '01_Вопросы_поставщику.txt';
    if (type === 'buyer') return d.filename === '02_ТЗ_байеру.md';
    if (type === 'cargo') return d.filename === '03_ТЗ_карго.md';
    if (type === 'sample') return d.filename === '04_Чеклист_образца.md';
    if (type === 'seo') return d.filename === '05_SEO_черновик.md';
    if (type === 'readme') return d.filename === '00_Инструкция.txt';
    return false;
  });
  if (!selected) {
    await ctx.answerCbQuery('Документ не найден').catch(() => {});
    return replySectionError(ctx, jobId, `materials_doc:${type}:missing`);
  }
  await ctx.answerCbQuery('Отправляю документ').catch(() => {});
  await sendDocs(ctx, ctx.chat!.id, [{ filename: selected.filename, text: selected.text }]);
  await ctx.reply('Документ отправлен. Можно вернуться к пакету или отчёту.', groupBackKeyboard(jobId)).catch(() => {});
}

export async function handleMaterialsZip(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^(?:materials_zip_|package_zip:)(.+)$/);
  if (!match) return;
  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  if (!job) { await ctx.answerCbQuery('Данные недоступны').catch(() => {}); return replySectionError(ctx, jobId, 'materials_zip:not_found'); }
  await ctx.answerCbQuery('Собираю ZIP').catch(() => {});
  const { docs, prefix, imageUrls } = buildMaterials(job);
  const zip = new AdmZip();
  for (const doc of docs) zip.addFile(doc.filename, Buffer.from(doc.text, 'utf-8'));
  if (imageUrls?.length) {
    const imgZip = await zipBuilder.buildFromUrls(imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null);
    if (imgZip) zip.addFile('06_Фото_товара.zip', imgZip);
  } else {
    zip.addFile('06_Фото_товара.zip', Buffer.from('Фото не удалось скачать автоматически. Используйте фото из карточки 1688 вручную.\n', 'utf-8'));
  }
  await ctx.telegram.sendDocument(ctx.chat!.id, Input.fromBuffer(zip.toBuffer(), `${prefix}.zip`)).catch(() => {});
  await ctx.reply('✅ ZIP отправлен. Начните с 01_Вопросы_поставщику.txt: отправьте вопросы поставщику, затем передайте ТЗ байеру и карго.', materialsKeyboard(jobId)).catch(() => {});
}

export async function handleMaterialsList(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_list[:_](.+)$/);
  if (!match) return;
  const jobId = match[1];
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('📁 В новом MVP отдельная массовая отправка файлов отключена. Скачайте ZIP — внутри 5 документов, README и 06_Фото_товара.zip.', materialsKeyboard(jobId)).catch(() => {});
}
