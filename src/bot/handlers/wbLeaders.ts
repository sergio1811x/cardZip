import type { Context } from 'telegraf';

export async function handleLegacyLeaders(ctx: Context) {
  await ctx.answerCbQuery('Этот старый раздел отключён. CardZip сейчас собирает закупочный пакет.').catch(() => {});
}
