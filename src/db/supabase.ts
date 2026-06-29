import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY обязательны');
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket as any },
});
