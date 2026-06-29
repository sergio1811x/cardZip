import { createClient } from '@supabase/supabase-js';
import WS from 'ws';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY обязательны');
}

// Node 20 does not provide a native WebSocket constructor compatible with
// @supabase/realtime-js. Supabase initializes RealtimeClient during createClient(),
// even if the app only uses PostgREST/Auth/Storage. Passing ws explicitly keeps the
// server runtime stable on Node 20/Vercel/Docker. Remove this only after moving to
// a Node runtime where Supabase no longer requires the transport override.
const supabaseOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: WS,
  },
} as unknown as Parameters<typeof createClient>[2];

// Singleton — переиспользуется между вызовами одной serverless-функции
export const supabase = createClient(url, key, supabaseOptions);
