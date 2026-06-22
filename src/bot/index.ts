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

// ─── Успешная оплата ──────────────────────────────────────────────────────────
bot.on('successful_payment', handleSuccessPayment);

// ─── Текстовые сообщения: определяем 1688 URL ─────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = (ctx as any).dbUserId as string | undefined;

  // Ищем 1688 URL в тексте
  const urlMatch = text.match(/https?:\/\/[^\s]*1688\.com[^\s]*/);
  if (!urlMatch) {
    await ctx.reply(
      'Пришли ссылку на товар с 1688.com.\n\nПример:\n<code>https://detail.1688.com/offer/XXXXXXXX.html</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (!userId) {
    await ctx.reply('❌ Не удалось определить пользователя. Попробуй /start');
    return;
  }

  // Rate limit
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
