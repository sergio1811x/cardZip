import type { Context } from 'telegraf';
import { Input, Markup } from 'telegraf';
import AdmZip from 'adm-zip';
import { supabase } from '../../db/supabase';
import { buildEconomicsDetail, buildWbDetail, build1688Detail, buildProcurementPlanDetail, buildMainMessage } from '../../core/messageBuilder';
import { buildCargoBrief, buildInfographicBrief, buildRiskChecklist, buildSampleRecommendation, buildSampleChecklist, buildSupplierQuestions, buildDecisionContext, validateGeneratedText } from '../../core/decisionLayer';
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
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
    [Markup.button.callback('📁 Закупочный пакет', `materials_${jobId}`), Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function materialsKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬇️ Скачать ZIP', `materials_zip_${jobId}`)],
    [Markup.button.callback('💬 Вопросы поставщику', `supplier_questions_${jobId}`), Markup.button.callback('📄 Что внутри пакета', `materials_inside_${jobId}`)],
    [Markup.button.callback('⬅️ Назад', `back_main_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function groupBackKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Назад', `materials_${jobId}`), Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`)],
    [Markup.button.callback('🔄 Новый товар', 'new_search')],
  ]);
}

function safeSectionErrorKeyboard(jobId: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏠 К отчёту', `back_main_${jobId}`), Markup.button.callback('📁 Закупочный пакет', `materials_${jobId}`)],
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
  const questions = buildSupplierQuestions(product);
  const ru = questions.ru.slice(0, 10).map((q, i) => `${i + 1}. ${q}`);
  const cnRaw = questions.cn.slice(0, 10);
  const cn = cnRaw.map((q, i) => `${i + 1}. ${q}`);
  const lines = ['# Вопросы поставщику', '', '## Русская версия', '', 'Здравствуйте. Хотим уточнить товар перед заказом:', '', ...ru];
  if (cnBlockIsSafe(cnRaw)) {
    lines.push('', '## Китайская версия', '', ...cn);
  } else {
    lines.push('', '## Китайская версия', '', 'Китайская версия не сформирована — используйте русскую версию или переведите через байера.');
  }
  return lines.join('\n');
}

function buildReadmeText(hasPhotos: boolean): string {
  return [
    'CardZip — закупочный пакет',
    '',
    'Что внутри:',
    '',
    '1. supplier_questions.txt',
    'Вопросы поставщику на русском и китайском.',
    '',
    '2. buyer_brief.md',
    'ТЗ байеру: что закупаем, цена, SKU, что проверить.',
    '',
    '3. cargo_brief.md',
    'ТЗ карго: вес, габариты, упаковка, ограничения.',
    '',
    '4. sample_checklist.md',
    'Что проверить до образца, на образце и перед партией.',
    '',
    '5. seo_draft.md',
    'Черновик карточки WB/Ozon и идеи инфографики.',
    '',
    '6. photos.zip',
    hasPhotos ? 'Фото товара с 1688.' : 'Фото не удалось скачать. Используйте фото из карточки 1688 вручную.',
    '',
    'Рекомендуемый порядок:',
    '1. Отправьте вопросы поставщику.',
    '2. Получите вес, габариты и реальные фото.',
    '3. Закажите 1–2 образца.',
    '4. Проверьте образец по чек-листу.',
    '5. После образца принимайте решение по партии.',
  ].join('\n');
}

function buildMaterials(job: any): { product?: ProductWithContent; prefix: string; docs: Array<{ filename: string; text: string; title: string; description: string }>; imageUrls: string[] } {
  const result = job.result_json as any;
  const product = result?.product as ProductWithContent | undefined;
  const generatedFiles = result?.generatedFiles ?? {};
  const offerId = String(product?.productId ?? result?.offerId ?? job.id ?? Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(-12) || Date.now().toString().slice(-8);
  const prefix = `cardzip_${offerId}_${safePrefix(product, offerId)}`.replace(/_+/g, '_').replace(/_$/g, '');
  const safeFlags = (product?.riskFlags ?? {}) as any;
  const imageUrls = (result?.imageUrls ?? product?.imageUrls ?? product?.images ?? []) as string[];

  const supplierText = product ? buildSupplierQuestionsText(product) : (generatedFiles?.supplierQuestions ?? generatedFiles?.supplierText ?? '');
  const buyerText = product ? formatOrderBrief(product, product.seoContent ?? {}, product.economics, safeFlags, job.input_url, product.budgets, product.conclusion) : (generatedFiles?.briefText ?? '');
  const cargoText = product ? buildCargoBrief(product, job.input_url) : (generatedFiles?.cargoText ?? '');
  const sampleText = product ? buildSampleChecklist(product) : (generatedFiles?.sampleChecklistText ?? generatedFiles?.sampleRecommendationText ?? generatedFiles?.riskChecklistText ?? '');
  const seoText = product ? formatSeoText(product, product.seoContent ?? {}, safeFlags) : (generatedFiles?.seoText ?? '');
  const readmeText = buildReadmeText(imageUrls.length > 0);

  const docs = [
    { filename: 'supplier_questions.txt', text: cleanDoc(product, String(supplierText), 'supplierQuestions'), title: '💬 supplier_questions.txt', description: 'Вопросы поставщику RU/CN.' },
    { filename: 'buyer_brief.md', text: cleanDoc(product, String(buyerText), 'buyerBrief'), title: '📄 buyer_brief.md', description: 'ТЗ байеру: товар, SKU, цена, что проверить.' },
    { filename: 'cargo_brief.md', text: cleanDoc(product, String(cargoText), 'buyerBrief'), title: '🚚 cargo_brief.md', description: 'ТЗ карго: вес, габариты, упаковка и ограничения.' },
    { filename: 'sample_checklist.md', text: cleanDoc(product, String(sampleText), 'buyerBrief'), title: '🧪 sample_checklist.md', description: 'Образец, риски, красные флаги и решение.' },
    { filename: 'seo_draft.md', text: cleanDoc(product, String(seoText), 'seo'), title: '📝 seo_draft.md', description: 'SEO-черновик WB/Ozon + идеи инфографики.' },
    { filename: 'README.txt', text: readmeText, title: 'ℹ️ README.txt', description: 'Что внутри пакета и порядок работы.' },
  ].filter(d => d.text && d.text.trim().length > 0);

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
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_(.+)$/);
  if (!match) return;

  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'materials:not_found');
  }

  await ctx.answerCbQuery().catch(() => {});
  const { docs, imageUrls } = buildMaterials(job);
  const preview = [
    '📁 <b>Закупочный пакет</b>',
    '',
    'Здесь собран пакет, который можно отправить поставщику, байеру и карго.',
    '',
    '<b>Что внутри:</b>',
    '• supplier_questions.txt — вопросы поставщику RU/CN',
    '• buyer_brief.md — ТЗ байеру',
    '• cargo_brief.md — ТЗ карго',
    '• sample_checklist.md — чек-лист образца и риски',
    '• seo_draft.md — SEO-черновик и идеи инфографики',
    '• README.txt — порядок работы',
    imageUrls.length ? '• photos.zip — фото товара' : '• photos.zip — фото не найдены, используйте карточку вручную',
    '',
    '<b>Что делать сейчас:</b>',
    '1. Сначала отправьте вопросы поставщику.',
    '2. Затем скачайте ZIP и передайте документы в работу.',
    '',
    `Документов: ${docs.filter(d => d.filename !== 'README.txt').length} + README${imageUrls.length ? ' + photos.zip' : ''}`,
  ].join('\n');
  await ctx.reply(preview, {
    parse_mode: 'HTML',
    ...materialsKeyboard(jobId),
  });
}

export async function handleMaterialsInside(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_inside_(.+)$/);
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
    imageUrls.length ? '📷 photos.zip\nФото товара с 1688 будут внутри ZIP.' : '📷 photos.zip\nФото не удалось получить автоматически. Используйте фото из карточки 1688 вручную.',
    '',
    '<b>Что делать сейчас:</b>',
    'отправьте supplier_questions.txt поставщику, затем используйте buyer_brief.md и cargo_brief.md для команды.',
  ];
  await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML', ...groupBackKeyboard(jobId) });
}

// Legacy group callback kept for old inline buttons. It no longer exposes removed MVP documents.
export async function handleMaterialsGroup(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_group_(questions|buyer_cargo|check|card)_(.+)$/);
  if (!match) return;
  const jobId = match[2];
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('📁 <b>Закупочный пакет</b>\n\nВ новом MVP отдельные группы убраны. Откройте состав пакета или скачайте ZIP.', { parse_mode: 'HTML', ...materialsKeyboard(jobId) });
}

export async function handleMaterialsDoc(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_doc_(questions|buyer|cargo|sample|seo|readme)_(.+)$/);
  if (!match) return;
  const [, type, jobId] = match;
  const job = await getJobData(ctx, jobId);
  if (!job) {
    await ctx.answerCbQuery('Данные недоступны').catch(() => {});
    return replySectionError(ctx, jobId, 'materials_doc:not_found');
  }
  const { docs } = buildMaterials(job);
  const selected = docs.find((d) => {
    if (type === 'questions') return d.filename === 'supplier_questions.txt';
    if (type === 'buyer') return d.filename === 'buyer_brief.md';
    if (type === 'cargo') return d.filename === 'cargo_brief.md';
    if (type === 'sample') return d.filename === 'sample_checklist.md';
    if (type === 'seo') return d.filename === 'seo_draft.md';
    if (type === 'readme') return d.filename === 'README.txt';
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
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_zip_(.+)$/);
  if (!match) return;
  const jobId = match[1];
  const job = await getJobData(ctx, jobId);
  if (!job) return void await ctx.answerCbQuery('Данные недоступны');
  await ctx.answerCbQuery('Собираю ZIP').catch(() => {});
  const { docs, prefix, imageUrls } = buildMaterials(job);
  const zip = new AdmZip();
  for (const doc of docs) zip.addFile(doc.filename, Buffer.from(doc.text, 'utf-8'));
  if (imageUrls?.length) {
    const imgZip = await zipBuilder.buildFromUrls(imageUrls, { maxImages: 15, maxSizeBytes: 20 * 1024 * 1024 }).catch(() => null);
    if (imgZip) zip.addFile('photos.zip', imgZip);
  } else {
    zip.addFile('photos.zip', Buffer.from('Фото не удалось скачать автоматически. Используйте фото из карточки 1688 вручную.\n', 'utf-8'));
  }
  await ctx.telegram.sendDocument(ctx.chat!.id, Input.fromBuffer(zip.toBuffer(), `${prefix}.zip`)).catch(() => {});
  await ctx.reply('✅ ZIP отправлен. Начните с supplier_questions.txt: отправьте вопросы поставщику, затем используйте пакет для байера и карго.', materialsKeyboard(jobId)).catch(() => {});
}

export async function handleMaterialsList(ctx: Context): Promise<void> {
  const match = (ctx.callbackQuery as any)?.data?.match(/^materials_list_(.+)$/);
  if (!match) return;
  const jobId = match[1];
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('📁 В новом MVP отдельная массовая отправка файлов отключена. Скачайте ZIP — внутри 5 документов, README и photos.zip.', materialsKeyboard(jobId)).catch(() => {});
}
