import type { Context } from 'telegraf';
import { sendInvoice, handleSuccessfulPayment } from '../../services/paymentService';
import { track } from '../../services/analyticsService';
import { Markup } from 'telegraf';

export async function handleUpgrade(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'upgrade_clicked');

  await ctx.reply(
    '💳 <b>Купить анализы</b>\n\n' +
    'Каждый анализ включает:\n' +
    '• разбор поставщика из Китая\n' +
    '• ориентир по рынку WB\n' +
    '• расчёт закупочной экономики\n' +
    '• SEO-карточку и материалы\n' +
    '• ТЗ байеру и вопросы поставщику\n\n' +
    'Выберите пакет:',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🧪 Тест · 1 ⭐', 'pay_test')],
        [Markup.button.callback('10 анализов · 150 ⭐', 'pay_pack10')],
        [Markup.button.callback('30 анализов · 300 ⭐', 'pay_pack30')],
        [Markup.button.callback('7 дней Pro · 500 ⭐', 'pay_week')],
      ]),
    }
  );
}

export async function handlePayTest(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  await sendInvoice(ctx, 'test');
}

export async function handlePayPack10(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'upgrade_clicked', { package: 'pack10' });
  await sendInvoice(ctx, 'pack10');
}

export async function handlePayPack30(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'upgrade_clicked', { package: 'pack30' });
  await sendInvoice(ctx, 'pack30');
}

export async function handlePayWeek(ctx: Context): Promise<void> {
  await ctx.answerCbQuery();
  const userId = (ctx as any).dbUserId as string | undefined;
  if (userId) track(userId, 'upgrade_clicked', { package: 'week' });
  await sendInvoice(ctx, 'week');
}

export async function handleSuccessPayment(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;
  await handleSuccessfulPayment(ctx, userId);
}
