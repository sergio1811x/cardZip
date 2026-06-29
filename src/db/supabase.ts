import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY обязательны');
}

// Singleton — переиспользуется между вызовами одной serverless-функции
export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
