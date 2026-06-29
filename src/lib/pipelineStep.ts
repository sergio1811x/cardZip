type HeaderValue = string | string[] | undefined;

type PipelineRequestLike = {
  headers?: Record<string, HeaderValue>;
};

type TriggerOptions = {
  attempts?: number;
  timeoutMs?: number;
  logPrefix?: string;
};

function firstHeader(value: HeaderValue): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}


function isDetachedMode(): boolean {
  const mode = String(process.env.PIPELINE_TRIGGER_MODE ?? '').toLowerCase().trim();
  if (mode === 'await' || mode === 'await_response' || mode === 'sync') return false;
  if (mode === 'detached' || mode === 'background' || mode === 'fire_and_forget') return true;

  // Railway/Docker/VPS runtimes do not need Vercel-style step chaining with a short
  // response timeout. Detached mode lets the next route finish even if LLM/1688 calls
  // take 60–180 seconds. On Vercel keep the old await mode unless explicitly changed.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RENDER || process.env.FLY_APP_NAME) {
    return true;
  }
  return !process.env.VERCEL;
}

export function getPipelineBaseUrl(req?: PipelineRequestLike): string {
  const envBase =
    process.env.INTERNAL_APP_URL ||
    process.env.APP_URL ||
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

  if (envBase) return trimTrailingSlash(envBase);

  // Local HTTP fallback for Railway/Docker single-container deployments. This lets
  // bot callbacks such as SKU selection trigger /api/step2-ai without hardcoding
  // a public Vercel URL. Prefer INTERNAL_APP_URL/APP_URL in production when set.
  if (!req && !process.env.VERCEL) {
    const port = process.env.BOT_PORT || process.env.PORT || '8080';
    return `http://127.0.0.1:${port}`;
  }

  const headers = req?.headers ?? {};
  const host = firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
  if (!host) return '';

  const forwardedProto = firstHeader(headers['x-forwarded-proto']).split(',')[0]?.trim();
  const proto = forwardedProto || (host.includes('localhost') || host.includes('127.0.0.1') || host.includes(':8080') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function triggerPipelineStep(
  req: PipelineRequestLike | undefined,
  path: string,
  body: object,
  options: TriggerOptions = {}
): Promise<boolean> {
  const baseUrl = getPipelineBaseUrl(req);
  const attempts = Math.max(1, options.attempts ?? 2);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 8_000);
  const logPrefix = options.logPrefix ?? 'pipeline';

  if (!baseUrl) {
    console.error(`[${logPrefix}] Cannot trigger ${path}: APP_URL/PUBLIC_APP_URL/INTERNAL_APP_URL or request host is missing`);
    return false;
  }

  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  if (isDetachedMode()) {
    // Railway/VPS mode: do not wait for the whole next step. The old 8s AbortController
    // was safe for Vercel triggers, but on Railway it killed the client side while
    // RapidAPI/LLM could legitimately run 60–180s. That made Telegram progress reach
    // 100% while the backend was already out of sync.
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        if (!response.ok) {
          const preview = await response.text().catch(() => '');
          console.error(`[${logPrefix}] detached ${path} returned HTTP ${response.status}: ${preview.slice(0, 240)}`);
        } else {
          console.log(`[${logPrefix}] detached ${path} accepted`);
        }
      })
      .catch((error: any) => {
        console.error(`[${logPrefix}] detached ${path} failed: ${error?.message ?? String(error)}`);
      });
    return true;
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (response.ok) return true;

      const preview = await response.text().catch(() => '');
      console.warn(`[${logPrefix}] ${path} attempt ${attempt}/${attempts} returned HTTP ${response.status}: ${preview.slice(0, 160)}`);
    } catch (error: any) {
      console.warn(`[${logPrefix}] ${path} attempt ${attempt}/${attempts} failed: ${error?.message ?? String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 600));
  }

  return false;
}
