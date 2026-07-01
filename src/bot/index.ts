import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { userMiddleware } from './middleware/user';
import { handleStart } from './handlers/start';
import { handleLink } from './handlers/link';
import { handleUpgrade, handlePayTest, handlePayPack10, handlePayPack30, handlePayWeek, handleSuccessPayment } from './handlers/upgrade';
import { handleLast } from './handlers/last';
import { handleAdmin, handleUpdateWbCategories, handleAdminWbDateInput, getAdminWbDatePending } from './handlers/admin';
import { isAppError } from '../lib/errors';
import { checkCallbackLimit, checkGlobalLimit } from './middleware/rateLimit';
import { handleSupplierQuestions, handleSupplierQuestionsLang } from './handlers/supplierQuestions';
import { handleTariffsMenu, handleEditTariff, handleResetTariffs, handleTariffInput, getPendingEdit } from './handlers/tariffs';
import { handleRewrite } from './handlers/rewrite';
import { handleQuickTariff } from './handlers/quickTariff';
import { handleSearch1688 } from './handlers/search1688';
import { handleWbLeaders } from './handlers/wbLeaders';
import { handleSkuSelect } from './handlers/skuSelect';
import { handleSupplierConfirmStart, handleSupplierConfirmText, getPendingConfirm } from './handlers/supplierConfirm';
import { handleMyAnalyses, handleAnalysisDetail } from './handlers/myAnalyses';
import { handleManualWeightStart, handleManualSalePriceStart, handleManualCompetitorsStart, handleManualInputText, getPendingManualInput } from './handlers/manualInputs';
import { handleEconDetail, handleWbDetail, handleMaterialsResend, handleMaterialsZip, handleMaterialsList, handleMaterialsInside, handleMaterialsGroup, handleMaterialsDoc, handleBackToMain, handleProductDetail, handleRiskDetail, handleSampleDetail, handleProcurementPlan } from './handlers/detailButtons';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

export const bot = new Telegraf(token);

// ─── Глобальные middleware ─────────────────────────────────────────────────────
bot.use(userMiddleware);

// Rate limit для callbacks
bot.use(async (ctx, next) => {
  if (!ctx.callbackQuery) return next();
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return next();

  const [cbRL, globalRL] = await Promise.all([
    checkCallbackLimit(userId),
    checkGlobalLimit(userId),
  ]);

  if (!cbRL.allowed) {
    await ctx.answerCbQuery('⏳ Слишком быстро. Подождите пару секунд.').catch(() => {});
    return;
  }
  if (!globalRL.allowed) {
    await ctx.answerCbQuery('⏳ Слишком много действий. Подождите минуту.').catch(() => {});
    return;
  }
  return next();
});

// Auto-cleanup stuck jobs при любом действии юзера
bot.use(async (ctx, next) => {
  const userId = (ctx as any).dbUserId as string | undefined;
  const chatId = ctx.chat?.id;
  if (userId && chatId) {
    try {
      const { cleanupStuckJobs } = require('../lib/jobCleanup');
      await cleanupStuckJobs(userId, chatId, ctx);
    } catch {}
  }
  return next();
});

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.command('start', handleStart);
bot.command('upgrade', handleUpgrade);
bot.command('last', handleLast);
bot.command('admin', handleAdmin);
bot.command('tariffs', async (ctx) => handleTariffsMenu(ctx));
bot.command('my', (ctx) => handleMyAnalyses(ctx));

// ─── Callback-кнопки ──────────────────────────────────────────────────────────
bot.action('upgrade', async (ctx) => {
  await ctx.answerCbQuery();
  return handleUpgrade(ctx);
});
bot.action('pay_test', handlePayTest);
bot.action('pay_pack10', handlePayPack10);
bot.action('pay_pack30', handlePayPack30);
bot.action('pay_week', handlePayWeek);

bot.action('tariffs', async (ctx) => {
  await ctx.answerCbQuery();
  return handleTariffsMenu(ctx);
});
bot.action('example_result', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `📋 <b>Пример результата CardZip</b>

` +
      `📦 Товар: бахилы многоразовые для обуви
` +
      `• цена, MOQ, SKU и поставщик
` +
      `• вопросы поставщику RU/CN
` +
      `• ТЗ байеру и ТЗ карго
` +
      `• чек-лист образца
` +
      `• SEO-черновик для маркетплейса и идеи инфографики

` +
      `Отправьте ссылку 1688 — соберу такой пакет по вашему товару.`,
    { parse_mode: 'HTML' },
  );
});
bot.action('how_it_works', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `ℹ️ <b>Как это работает</b>

` +
      `1. Вы отправляете ссылку 1688 / Taobao / Tmall.
` +
      `2. CardZip разбирает товар, SKU, цену, MOQ и поставщика.
` +
      `3. Я готовлю закупочный пакет: вопросы поставщику, ТЗ байеру, ТЗ карго, чек-лист образца, SEO-черновик и фото.
` +
      `4. После ответа поставщика можно обновить пакет по весу, цене, MOQ и упаковке.

` +
      `Я не обещаю прибыльность и не заменяю ручную проверку рынка — задача CardZip подготовить товар к закупке без китайского хаоса.`,
    { parse_mode: 'HTML' },
  );
});

bot.action('new_search', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Отправьте ссылку на товар с 1688 / Taobao / Tmall 👇');
});
bot.action('last', async (ctx) => {
  await ctx.answerCbQuery();
  return handleLast(ctx);
});
bot.action('my_analyses', async (ctx) => {
  await ctx.answerCbQuery();
  return handleMyAnalyses(ctx);
});
bot.action(/^analyses_page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1]);
  return handleMyAnalyses(ctx, page);
});
bot.action(/^analysis_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleAnalysisDetail(ctx);
});
bot.action('admin_update_wb_cats', handleUpdateWbCategories);
bot.action('supplier_questions', async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierQuestions(ctx);
});
bot.action(/^supplier_questions[:_](.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierQuestions(ctx);
});
bot.action(/^sq[:_](ru|cn)(?:[:_](.+))?$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierQuestionsLang(ctx);
});
bot.action('edit_tariffs', async (ctx) => {
  await ctx.answerCbQuery();
  return handleTariffsMenu(ctx);
});
bot.action('edit_params', async (ctx) => {
  await ctx.answerCbQuery();
  return handleTariffsMenu(ctx);
});
bot.action('buy_analyses', async (ctx) => {
  await ctx.answerCbQuery();
  return handleUpgrade(ctx);
});
bot.action(/^edit_tariff_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleEditTariff(ctx);
});
bot.action('reset_tariffs', async (ctx) => {
  await ctx.answerCbQuery();
  return handleResetTariffs(ctx);
});

// ─── Детальные кнопки (себестоимость, данные товара, материалы) ──────────────
bot.action(/^product_details?[:_](.+)$/, handleProductDetail);
bot.action(/^proc_plan_(.+)$/, handleProcurementPlan);
bot.action(/^econ_detail_(.+)$/, handleEconDetail);
bot.action(/^wb_detail_(.+)$/, handleWbDetail);
bot.action(/^(?:materials_zip_|package_zip:)(.+)$/, handleMaterialsZip);
bot.action(/^materials_inside[:_](.+)$/, handleMaterialsInside);
bot.action(/^materials_group[:_](questions|buyer_cargo|check|card)[:_](.+)$/, handleMaterialsGroup);
bot.action(/^materials_doc[:_](questions|buyer|cargo|sample|seo|readme)[:_](.+)$/, handleMaterialsDoc);
bot.action(/^materials_list[:_](.+)$/, handleMaterialsList);
bot.action(/^(?:materials_|package:)(.+)$/, handleMaterialsResend);
bot.action(/^risk_detail_(.+)$/, handleRiskDetail);
bot.action(/^sample_detail_(.+)$/, handleSampleDetail);
bot.action(/^back_main[:_](.+)$/, handleBackToMain);

// ─── Ручные вводы: вес, сценарная цена, конкуренты вручную ─────────────────
bot.action(/^weight_input:(.+)$/, handleManualWeightStart);
bot.action(/^manual_price_(.+)$/, handleManualSalePriceStart);
bot.action(/^manual_competitors_(.+)$/, handleManualCompetitorsStart);

// ─── Быстрые тарифы (inline под экономикой) ──────────────────────────────────
bot.action(/^(cargo|ff)_(\d+)_(.+)$/, async (ctx) => {
  return handleQuickTariff(ctx);
});

// ─── Подтверждение от поставщика ─────────────────────────────────────────────
bot.action('supplier_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierConfirmStart(ctx);
});
bot.action(/^supplier_confirm[:_](.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierConfirmStart(ctx);
});

// ─── Выбор SKU ──────────────────────────────────────────────────────────────
bot.action(/^sku_(all|\d+)_(.+)$/, async (ctx) => {
  return handleSkuSelect(ctx);
});

// ─── Лидеры WB ──────────────────────────────────────────────────────────────
bot.action(/^leaders_(.+)$/, async (ctx) => {
  return handleWbLeaders(ctx);
});

// ─── Найти на 1688 ──────────────────────────────────────────────────────────
bot.action(/^search_1688_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleSearch1688(ctx);
});

// ─── A/B рерайт SEO ─────────────────────────────────────────────────────────
bot.action(/^rw_(short|aggressive|premium)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleRewrite(ctx);
});

// ─── Оплата ──────────────────────────────────────────────────────────────────
bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
bot.on('successful_payment', handleSuccessPayment);

// ─── Текстовые сообщения ────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = (ctx as any).dbUserId as string | undefined;
  const chatId = ctx.chat?.id;

  // Проверяем pending states: admin wb date → подтверждение поставщика → тариф
  if (chatId) {
    const wbDatePending = await getAdminWbDatePending(chatId);
    if (wbDatePending) {
      const handled = await handleAdminWbDateInput(ctx, text);
      if (handled) return;
    }
    const manualPending = await getPendingManualInput(chatId);
    if (manualPending) {
      const handled = await handleManualInputText(ctx, text);
      if (handled) return;
    }
    const confirmPending = await getPendingConfirm(chatId);
    if (confirmPending) {
      const handled = await handleSupplierConfirmText(ctx, text);
      if (handled) return;
    }
    const tariffPending = await getPendingEdit(chatId);
    if (tariffPending) {
      const handled = await handleTariffInput(ctx, text);
      if (handled) return;
    }
  }

  const urlMatch = text.match(/https?:\/\/[^\s]*(1688|taobao|tmall|qr\.1688)\.com[^\s]*/);
  if (!urlMatch) {
    await ctx.reply(
      'Вставьте ссылку на товар из Китая — бот разберёт за ~60 секунд.\n\nПоддерживаются: 1688, Taobao, Tmall.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  if (!userId) {
    await ctx.reply('Не удалось определить пользователя. Нажмите /start и попробуйте снова.');
    return;
  }

  return handleLink(ctx, urlMatch[0]);
});

// ─── Глобальный обработчик ошибок ─────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('[bot] Необработанная ошибка:', err);
  ctx.reply('⚠️ Не удалось открыть раздел.\n\nДанные анализа сохранены. Попробуйте вернуться к плану или открыть материалы ещё раз.\n\nЕсли ошибка повторится — начните новый товар.', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🏠 К отчёту', 'last')],
      [Markup.button.callback('🔄 Новый товар', 'new_search')],
    ]),
  }).catch(() => {});
});
