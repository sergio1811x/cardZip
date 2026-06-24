import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { userMiddleware } from './middleware/user';
import { handleStart } from './handlers/start';
import { handleLink } from './handlers/link';
import { handleUpgrade, handlePayTest, handlePayPack10, handlePayPack30, handlePayWeek, handleSuccessPayment } from './handlers/upgrade';
import { handleLast } from './handlers/last';
import { handleAdmin } from './handlers/admin';
import { isAppError } from '../lib/errors';
import { checkCallbackLimit, checkGlobalLimit } from './middleware/rateLimit';
import { handleSupplierQuestions, handleSupplierQuestionsLang } from './handlers/supplierQuestions';
import { handleTariffsMenu, handleEditTariff, handleResetTariffs, handleTariffInput, getPendingEdit } from './handlers/tariffs';
import { handleRewrite } from './handlers/rewrite';
import { handleQuickTariff } from './handlers/quickTariff';
import { handleSearch1688 } from './handlers/search1688';
import { handleSkuSelect } from './handlers/skuSelect';
import { handleSupplierConfirmStart, handleSupplierConfirmText, getPendingConfirm } from './handlers/supplierConfirm';

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

// ─── Команды ──────────────────────────────────────────────────────────────────
bot.command('start', handleStart);
bot.command('upgrade', handleUpgrade);
bot.command('last', handleLast);
bot.command('admin', handleAdmin);
bot.command('tariffs', async (ctx) => handleTariffsMenu(ctx));

// ─── Callback-кнопки ──────────────────────────────────────────────────────────
bot.action('upgrade', async (ctx) => {
  await ctx.answerCbQuery();
  return handleUpgrade(ctx);
});
bot.action('pay_test', handlePayTest);
bot.action('pay_pack10', handlePayPack10);
bot.action('pay_pack30', handlePayPack30);
bot.action('pay_week', handlePayWeek);
bot.action('new_search', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Отправь ссылку на товар с 1688.com 👇');
});
bot.action('last', async (ctx) => {
  await ctx.answerCbQuery();
  return handleLast(ctx);
});
bot.action('supplier_questions', async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierQuestions(ctx);
});
bot.action(/^sq_(ru|cn)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierQuestionsLang(ctx);
});
bot.action('edit_tariffs', async (ctx) => {
  await ctx.answerCbQuery();
  return handleTariffsMenu(ctx);
});
bot.action(/^edit_tariff_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return handleEditTariff(ctx);
});
bot.action('reset_tariffs', async (ctx) => {
  await ctx.answerCbQuery();
  return handleResetTariffs(ctx);
});

// ─── Быстрые тарифы (inline под экономикой) ──────────────────────────────────
bot.action(/^(cargo|ff)_(\d+)_(.+)$/, async (ctx) => {
  return handleQuickTariff(ctx);
});

// ─── Подтверждение от поставщика ─────────────────────────────────────────────
bot.action('supplier_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  return handleSupplierConfirmStart(ctx);
});

// ─── Выбор SKU ──────────────────────────────────────────────────────────────
bot.action(/^sku_(all|\d+)_(.+)$/, async (ctx) => {
  return handleSkuSelect(ctx);
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

  // Проверяем pending states: подтверждение поставщика → тариф
  if (chatId) {
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
      'Пришли ссылку на товар с 1688 или Taobao.\n\n' +
      'Примеры:\n' +
      '<code>https://detail.1688.com/offer/XXX.html</code>\n' +
      '<code>https://item.taobao.com/item.htm?id=XXX</code>\n' +
      'Также поддерживаются короткие ссылки из приложения 1688.',
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    );
    return;
  }

  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя. Попробуй /start');
    return;
  }

  return handleLink(ctx, urlMatch[0]);
});

// ─── Глобальный обработчик ошибок ─────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('[bot] Необработанная ошибка:', err);
  ctx.reply('❌ Внутренняя ошибка. Попробуй ещё раз.').catch(() => {});
});
