import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { upsertWbCategories, type WbCategory } from '../src/db/queries/wbCategories';

export const config = { maxDuration: 60 };

const WBCON_URL = 'https://wbcon.ru/wp-json/services-wb/v1/get_analysis_data';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const body = (req.body ?? {}) as any;
  const secret = req.headers['authorization'] ?? req.headers['x-cardzip-admin-secret'] ?? body.secret ?? req.query.secret;
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret !== expected && secret !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const dateParam = (body.date as string) || (req.query.date as string) || getLastSunday();

    const response = await fetch(WBCON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateParam }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: `wbcon returned ${response.status}` });
    }

    const data = await response.json() as any[];
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(200).json({ ok: false, error: 'empty response' });
    }

    const parseDate = data[0]?.parse_time?.slice(0, 10) ?? dateParam;

    const rows: WbCategory[] = data.map((r) => ({
      category: r.category ?? '',
      item: r.item ?? '',
      sellers: r.sellers ?? 0,
      sellers_with_orders: r.sellers_with_orders ?? 0,
      product_cards: r.product_cards ?? 0,
      product_cards_with_orders: r.product_cards_with_orders ?? 0,
      revenue_rub: r.revenue_rub ?? 0,
      average_check_rub: r.average_check_rub ?? 0,
      average_rating: r.average_rating ?? 0,
      stock_quantity: r.stock_quantity ?? 0,
      redemption_rate: r.redemption_rate ?? 0,
      monopolization_percentage: r.monopolization_percentage ?? 0,
      turnover_days_per_week: r.turnover_days_per_week ?? 0,
      availability: r.availability ?? 'Не рассчитано',
      parse_date: parseDate,
    }));

    const result = await upsertWbCategories(rows);

    console.log(`[wb-categories] Loaded ${result.total} / ${data.length} categories for ${parseDate}${result.error ? ` (error: ${result.error})` : ''}`);
    res.status(200).json({ ok: result.total > 0, loaded: result.total, total: data.length, date: parseDate, error: result.error });
  } catch (e: any) {
    console.error('[wb-categories]', e.message);
    res.status(500).json({ error: e.message });
  }
}

function getLastSunday(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}
