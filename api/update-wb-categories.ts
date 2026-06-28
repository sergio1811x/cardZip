import type { VercelRequest, VercelResponse } from '@vercel/node';
import 'dotenv/config';
import { upsertWbCategories, type WbCategory } from '../src/db/queries/wbCategories';

export const config = { maxDuration: 60 };

const WBCON_URL = 'https://wbcon.ru/wp-json/services-wb/v1/get_analysis_data';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const secret = req.headers['authorization'] ?? req.query.secret;
  const expected = process.env.WB_CATEGORIES_UPDATE_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || (secret !== expected && secret !== `Bearer ${expected}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const dateParam = (req.query.date as string) || getLastSunday();

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

    const toNumber = (value: unknown): number => {
      const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };

    const rows: WbCategory[] = data.map((r) => ({
      category: String(r.category ?? '').trim(),
      item: String(r.item ?? '').trim(),
      sellers: toNumber(r.sellers),
      sellers_with_orders: toNumber(r.sellers_with_orders),
      product_cards: toNumber(r.product_cards),
      product_cards_with_orders: toNumber(r.product_cards_with_orders),
      revenue_rub: toNumber(r.revenue_rub),
      average_check_rub: toNumber(r.average_check_rub),
      average_rating: toNumber(r.average_rating),
      stock_quantity: toNumber(r.stock_quantity),
      redemption_rate: toNumber(r.redemption_rate),
      monopolization_percentage: toNumber(r.monopolization_percentage),
      turnover_days_per_week: toNumber(r.turnover_days_per_week),
      availability: String(r.availability ?? 'Не рассчитано'),
      parse_date: parseDate,
    })).filter((row) => row.category || row.item);

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
