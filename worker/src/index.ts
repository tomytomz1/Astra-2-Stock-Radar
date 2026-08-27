import { FAILURE_ALERT_THRESHOLD, PRODUCT_URL } from '@astra/contract';
import type {
  AdapterName,
  DetectConfig,
  RegisterBody,
  StatusResponse,
  UnregisterBody,
} from '@astra/contract';
import { detect } from './detect/index';
import { detectConfig } from './detect/config';
import type { FetchLike } from './detect/types';
import { dispatch, type DispatchSummary } from './dispatch';
import type { KVStore } from './kv';
import { isValidExpoToken, registerDevice, unregisterDevice } from './registry';
import {
  applySnapshots,
  cacheSnapshots,
  readHealth,
  readSnapshotCache,
  recordFailure,
  recordSuccess,
} from './state';

export interface Env {
  /** KV namespace binding declared in wrangler.toml. */
  STOCK_KV: KVNamespace;
  /** Optional Expo access token for projects with enhanced push security. */
  EXPO_ACCESS_TOKEN?: string | undefined;
  /** Optional override of the watched product URL (useful for staging). */
  PRODUCT_URL?: string | undefined;
}

export interface PassDeps {
  kv: KVStore;
  fetchImpl: FetchLike;
  now: number;
  config?: DetectConfig;
  productUrl?: string;
  accessToken?: string | undefined;
}

export interface PassSummary {
  ok: boolean;
  adapter: AdapterName | null;
  reason: string | null;
  alerts: number;
  dispatch: DispatchSummary | null;
}

const EMPTY_DISPATCH: DispatchSummary = {
  messages: 0,
  accepted: 0,
  rejected: 0,
  prunedTokens: 0,
  errors: [],
};

/**
 * One cron pass: detect, latch, notify.
 *
 * INVARIANT 1 lives in the early return below. When detection fails we touch the failure counter
 * and NOTHING else -- no variant state, no snapshot cache, no pushes. Recording a failed fetch as
 * `available: false` would make the store's recovery look like a false -> true edge and fire a
 * phantom alert; that bug is the reason this whole system is shaped the way it is.
 */
export async function runPass(deps: PassDeps): Promise<PassSummary> {
  const productUrl = deps.productUrl ?? PRODUCT_URL;
  const result = await detect({
    productUrl,
    config: deps.config ?? detectConfig,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });

  if (!result.ok) {
    const { consecutiveFailures } = await recordFailure(deps.kv, result.reason, deps.now);
    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      // Surfaced through `GET /status` and the logs rather than a push: the contract's only push
      // payload is `kind: 'restock'`, and an app that deep-links "tap to buy" on a
      // detector-is-broken alert would be worse than silence.
      console.warn(
        `[astra] detector unhealthy: ${consecutiveFailures} consecutive failures. Last: ${result.reason}`,
      );
    }
    return {
      ok: false,
      adapter: null,
      reason: result.reason,
      alerts: 0,
      dispatch: null,
    };
  }

  const { alerts } = await applySnapshots(deps.kv, result.snapshots, deps.now);
  await cacheSnapshots(deps.kv, result.snapshots, deps.now);
  await recordSuccess(deps.kv, result.adapter, deps.now);

  const dispatchSummary =
    alerts.length === 0
      ? EMPTY_DISPATCH
      : await dispatch({
          kv: deps.kv,
          fetchImpl: deps.fetchImpl,
          alerts,
          now: deps.now,
          accessToken: deps.accessToken,
          productUrl,
        });

  return {
    ok: true,
    adapter: result.adapter,
    reason: null,
    alerts: alerts.length,
    dispatch: dispatchSummary,
  };
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  // The Expo app has no fixed origin (custom scheme on device, localhost in dev) and the API
  // holds nothing secret -- only opaque push tokens supplied by the caller itself.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseRegisterBody(body: Record<string, unknown>): RegisterBody | string {
  const token = body['token'];
  if (!isValidExpoToken(token)) {
    return 'token must look like ExponentPushToken[...] or ExpoPushToken[...]';
  }
  const variantIdsRaw = body['variantIds'];
  if (!Array.isArray(variantIdsRaw) || !variantIdsRaw.every((id) => typeof id === 'string')) {
    return 'variantIds must be an array of strings (empty means all variants)';
  }
  const platform = body['platform'];
  if (platform !== 'ios' && platform !== 'android') return "platform must be 'ios' or 'android'";
  return { token, variantIds: variantIdsRaw, platform };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return json({ error: 'body must be a JSON object' }, 400);
  const parsed = parseRegisterBody(body);
  if (typeof parsed === 'string') return json({ error: parsed }, 400);
  const devices = await registerDevice(env.STOCK_KV, parsed, Date.now());
  return json({ ok: true, deviceCount: devices.length });
}

async function handleUnregister(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) return json({ error: 'body must be a JSON object' }, 400);
  const token = body['token'];
  if (typeof token !== 'string' || token === '') return json({ error: 'token is required' }, 400);
  const payload: UnregisterBody = { token };
  const removed = await unregisterDevice(env.STOCK_KV, payload.token);
  return json({ ok: true, removed });
}

/**
 * `GET /status`.
 *
 * `snapshots` come from the write-on-change cache, so their `checkedAt` is the last time the
 * data materially changed, not the last poll. `lastSuccessAt` answers "is the watcher alive?"
 * and is refreshed at most every `HEALTH_REFRESH_MS` (5 min), so the app's "last checked" line
 * can lag reality by up to that much -- both are consequences of the write budget (invariant 3).
 */
export async function handleStatus(kv: KVStore): Promise<StatusResponse> {
  const [health, cache] = await Promise.all([readHealth(kv), readSnapshotCache(kv)]);
  return {
    snapshots: cache?.snapshots ?? [],
    lastSuccessAt: health?.lastSuccessAt ?? null,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    adapter: health?.lastAdapter ?? null,
  };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const work = runPass({
      kv: env.STOCK_KV,
      fetchImpl: (url, init) => fetch(url, init as RequestInit),
      now: Date.now(),
      productUrl: env.PRODUCT_URL ?? PRODUCT_URL,
      accessToken: env.EXPO_ACCESS_TOKEN,
    }).then((summary) => {
      console.log(`[astra] pass ${JSON.stringify(summary)}`);
    });
    ctx.waitUntil(work);
    await work;
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (request.method === 'POST' && url.pathname === '/register') {
      return handleRegister(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/unregister') {
      return handleUnregister(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      return json(await handleStatus(env.STOCK_KV));
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
