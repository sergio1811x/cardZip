import type { Context } from 'telegraf';
import { findLastProductByUser } from '../../db/queries/products';
import { track } from '../../services/analyticsService';

export async function handleLast(ctx: Context): Promise<void> {
  const userId = (ctx as any).dbUserId as string | undefined;
  if (!userId) return;

  track(userId, 'last_used');

  const product = await findLastProductByUser(userId);
  if (!product) {
    await ctx.reply('У тебя пока нет сохранённых товаров. Отправь ссылку на 1688 — всё сохранится автоматически.');
    return;
  }

  const data = product.data_json as any;
  const seoContent = data?.seoContent;
  const wbData = data?.wbData;

  await ctx.reply(
    `📋 <b>Последний товар</b>\n\n` +
      `<b>${escHtml(product.title_ru ?? product['1688_id'])}</b>\n\n` +
      `Цена: ${product.price_yuan} ¥\n` +
      `Вес: ${product.weight_kg} кг\n` +
      (wbData ? `Ср. цена WB: ${wbData.avgPrice?.toLocaleString('ru-RU')} ₽\n` : '') +
      `\nСохранён: ${new Date(product.created_at).toLocaleDateString('ru-RU')}\n\n` +
      `Чтобы обновить данные — отправь ссылку заново.`,
    { parse_mode: 'HTML' }
  );
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
