type HeaderValue = string | string[] | undefined;

type PipelineRequestLike = {
  headers?: Record<string, HeaderValue>;
};

type TriggerOptions = {
  attempts?: number;
  timeoutMs?: number;
  logPrefix?: string;
  /** In detached Railway/VPS mode, wait briefly to catch immediate network/404 failures. */
  detachedAckTimeoutMs?: number;
};

function firstHeader(value: HeaderValue): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function withHttps(domainOrUrl: string): string {
  const value = String(domainOrUrl ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return trimTrailingSlash(value);
  return `https://${trimTrailingSlash(value)}`;
}

function isRailwayRuntime(): boolean {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

function isOldVercelUrl(value: string): boolean {
  return /(?:^https?:\/\/)?[^\s/]*vercel\.app(?:\/|$)/i.test(value);
}

function isServerlessRuntime(): boolean {
  return !!process.env.VERCEL;
}

function triggerMode(): string {
  return String(process.env.PIPELINE_TRIGGER_MODE ?? '').toLowerCase().trim();
}

function isDetachedMode(): boolean {
  const mode = triggerMode();
  if (mode === 'await' || mode === 'await_response' || mode === 'sync') return false;
  if (mode === 'detached' || mode === 'background' || mode === 'fire_and_forget' || mode === 'local') return true;

  // Railway/Docker/VPS runtimes do not need Vercel-style step chaining with a short
  // response timeout. Detached mode lets the next route finish even if LLM/1688 calls
  // take 60–180 seconds. On Vercel keep the old await mode unless explicitly changed.
  if (isRailwayRuntime() || process.env.RENDER || process.env.FLY_APP_NAME) {
    return true;
  }
  return !process.env.VERCEL;
}

function shouldUseLocalStepRunner(): boolean {
  const mode = triggerMode();
  if (mode === 'http' || mode === 'detached_http' || mode === 'external_http') return false;
  if (mode === 'local' || mode === 'in_process' || mode === 'detached') return !isServerlessRuntime();

  // On Railway/VPS the safest default is in-process chaining. It avoids the whole class
  // of APP_URL/INTERNAL_APP_URL/self-fetch bugs after SKU selection. HTTP self-calls are
  // still available by setting PIPELINE_TRIGGER_MODE=detached_http.
  return !isServerlessRuntime() && (isRailwayRuntime() || !process.env.VERCEL);
}

export function getPipelineBaseUrl(req?: PipelineRequestLike): string {
  const railwayBase = withHttps(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '');
  const configuredBase =
    process.env.INTERNAL_APP_URL ||
    process.env.APP_URL ||
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

  // On Railway, an old APP_URL=https://*.vercel.app is worse than no APP_URL: it sends
  // SKU continuation and step chaining to the previous deployment. Prefer Railway's
  // public domain or local container fallback in that case.
  if (configuredBase && !(isRailwayRuntime() && isOldVercelUrl(configuredBase))) {
    return trimTrailingSlash(configuredBase);
  }

  if (railwayBase) return railwayBase;

  // Local HTTP fallback for Railway/Docker single-container deployments. This lets
  // bot callbacks such as SKU selection trigger /api/step2-ai without hardcoding
  // a public Vercel URL. Prefer INTERNAL_APP_URL/APP_URL in production when set.
  if (!req && !process.env.VERCEL) {
    const port = process.env.PORT || process.env.BOT_PORT || '8080';
    return `http://127.0.0.1:${port}`;
  }

  const headers = req?.headers ?? {};
  const host = firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
  if (!host) return '';

  const forwardedProto = firstHeader(headers['x-forwarded-proto']).split(',')[0]?.trim();
  const proto = forwardedProto || (host.includes('localhost') || host.includes('127.0.0.1') || host.includes(':8080') ? 'http' : 'https');
  return `${proto}://${host}`;
}

type MockResponse = {
  statusCode: number;
  headersSent: boolean;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
  end(payload?: unknown): MockResponse;
};

function createMockResponse(logPrefix: string, path: string): MockResponse {
  return {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.headersSent = true;
      if (this.statusCode >= 400) {
        console.error(`[${logPrefix}] local ${path} returned ${this.statusCode}: ${JSON.stringify(payload).slice(0, 240)}`);
      }
      return this;
    },
    end(payload?: unknown) {
      this.headersSent = true;
      if (this.statusCode >= 400) {
        console.error(`[${logPrefix}] local ${path} ended ${this.statusCode}: ${String(payload ?? '').slice(0, 240)}`);
      }
      return this;
    },
  };
}

async function loadLocalHandler(path: string): Promise<any | null> {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  switch (normalized) {
    case '/api/step1-elim':
      return (await import('../../api/step1-elim')).default;
    case '/api/step2-ai':
      return (await import('../../api/step2-ai')).default;
    case '/api/step3-market':
      return (await import('../../api/step3-market')).default;
    case '/api/step4-send':
      return (await import('../../api/step4-send')).default;
    case '/api/step5-qa':
      return (await import('../../api/step5-qa')).default;
    case '/api/step6-send':
      return (await import('../../api/step6-send')).default;
    default:
      return null;
  }
}

function dispatchLocalPipelineStep(path: string, body: object, logPrefix: string): boolean {
  const normalized = path.startsWith('/') ? path : `/${path}`;

  // Do not await: this keeps Telegram webhook/callback responses fast while still
  // running the pipeline inside the same Railway container. It is intentionally not
  // tied to APP_URL, PUBLIC_APP_URL, DNS or self-fetch.
  setImmediate(async () => {
    try {
      const handler = await loadLocalHandler(normalized);
      if (!handler) {
        console.error(`[${logPrefix}] local pipeline does not know route ${normalized}`);
        return;
      }

      const req = {
        method: 'POST',
        body,
        headers: {
          host: `127.0.0.1:${process.env.PORT || process.env.BOT_PORT || '8080'}`,
          'x-forwarded-proto': 'http',
        },
      };
      const res = createMockResponse(logPrefix, normalized);
      await handler(req, res);
      console.log(`[${logPrefix}] local ${normalized} finished with status ${res.statusCode}`);
    } catch (error: any) {
      console.error(`[${logPrefix}] local ${normalized} failed: ${error?.message ?? String(error)}`);
    }
  });

  console.log(`[${logPrefix}] local ${normalized} dispatched`);
  return true;
}

export async function triggerPipelineStep(
  req: PipelineRequestLike | undefined,
  path: string,
  body: object,
  options: TriggerOptions = {}
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 8_000);
  const logPrefix = options.logPrefix ?? 'pipeline';

  if (isDetachedMode() && shouldUseLocalStepRunner()) {
    return dispatchLocalPipelineStep(path, body, logPrefix);
  }

  const baseUrl = getPipelineBaseUrl(req);
  if (!baseUrl) {
    console.error(`[${logPrefix}] Cannot trigger ${path}: APP_URL/PUBLIC_APP_URL/INTERNAL_APP_URL or request host is missing`);
    return false;
  }

  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  if (isDetachedMode()) {
    // Railway/VPS HTTP mode: do not wait for the whole next step. But do wait a very
    // short time to catch immediate problems such as wrong APP_URL/port, DNS failure,
    // or 404. Prefer local mode on Railway unless a multi-instance HTTP topology needs it.
    const request = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    request
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

    const ackTimeoutMs = Math.max(250, options.detachedAckTimeoutMs ?? 1_500);
    const immediate = await Promise.race<true | false | 'pending'>([
      request.then((response) => response.ok).catch(() => false),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ackTimeoutMs)),
    ]);

    if (immediate === false) {
      console.error(`[${logPrefix}] detached ${path} failed before ack timeout: ${url}`);
      return false;
    }

    console.log(`[${logPrefix}] detached ${path} dispatched: ${url}`);
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
