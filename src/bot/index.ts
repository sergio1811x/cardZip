import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { userMiddleware } from './middleware/user';
import { handleStart } from './handlers/start';
import { handleLink } from './handlers/link';
import { handleUpgrade, handlePaySeller, handlePayBusiness, handleSuccessPayment } from './handlers/upgrade';
import { handleLast } from './handlers/last';
import { handleAdmin } from './handlers/admin';
import { productImporter } from '../providers/productImporter';
import { isAppError } from '../lib/errors';
import { getStatus } from '../services/subscriptionService';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { handleSupplierQuestions, handleSupplierQuestionsLang } from './handlers/supplierQuestions';
import { handleTariffsMenu, handleEditTariff, handleResetTariffs, handleTariffInput, getPendingEdit } from './handlers/tariffs';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

export const bot = new Telegraf(token);

// ─── Глобальные middleware ─────────────────────────────────────────────────────
bot.use(userMiddleware);

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
bot.action('pay_seller', handlePaySeller);
bot.action('pay_business', handlePayBusiness);
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

// ─── Успешная оплата ──────────────────────────────────────────────────────────
bot.on('successful_payment', handleSuccessPayment);

// ─── Текстовые сообщения ────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = (ctx as any).dbUserId as string | undefined;
  const chatId = ctx.chat?.id;

  // Сначала проверяем: ожидает ли бот ввода тарифа
  if (chatId) {
    const pending = await getPendingEdit(chatId);
    if (pending) {
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

  try {
    const status = await getStatus(userId);
    const isPaid = status.plan !== 'free';
    await rateLimitMiddleware(isPaid)(ctx, async () => {});
  } catch (e) {
    if (isAppError(e) && e.code === 'RATE_LIMITED') {
      await ctx.reply(e.userMessage);
      return;
    }
  }

  return handleLink(ctx, urlMatch[0]);
});

// ─── Глобальный обработчик ошибок ─────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('[bot] Необработанная ошибка:', err);
  ctx.reply('❌ Внутренняя ошибка. Попробуй ещё раз.').catch(() => {});
});
