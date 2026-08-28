import { FAILURE_ALERT_THRESHOLD, KV_KEYS, PRODUCT_URL } from '@astra/contract';
import type {
  AdapterName,
  DetectConfig,
  DetectorPushData,
  RegisterBody,
  StatusResponse,
  StockSnapshot,
  UnregisterBody,
} from '@astra/contract';
import { detect } from './detect/index';
import { detectConfig } from './detect/config';
import type { FetchLike } from './detect/types';
import {
  dispatch,
  dispatchDetectorPage,
  dispatchHeartbeat,
  type DispatchSummary,
} from './dispatch';
import type { KVStore } from './kv';
import { isValidExpoToken, readRegistry, registerDevice, unregisterDevice } from './registry';
import {
  applySnapshots,
  cacheSnapshots,
  checkBackoff,
  readHealth,
  readSnapshotCache,
  recordFailure,
  recordRateLimited,
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
  /** Detector page sent this pass, if any. Null when the detector's status did not change. */
  detectorPage: DetectorPushData['kind'] | null;
  /** Delivery result of that page. Null when none was sent. */
  detectorDispatch: DispatchSummary | null;
  /**
   * Epoch ms until which polling is suspended, when this pass either set or observed a backoff.
   * Null on an ordinary pass.
   */
  rateLimitedUntil: number | null;
  /** True when this pass made no request at all because a backoff was already in force. */
  skipped: boolean;
}

const EMPTY_DISPATCH: DispatchSummary = {
  messages: 0,
  accepted: 0,
  rejected: 0,
  prunedTokens: 0,
  errors: [],
};

/**
 * Read `KV_KEYS.forceAlert`, and if it names a variant in this pass's snapshots, return that
 * snapshot and delete the key so the next pass is silent.
 *
 * Costs one KV read per pass (against a 100k/day budget) and a delete only when the flag was
 * actually set, so the write budget documented in `state.ts` is unaffected.
 */
async function consumeForceAlert(
  kv: KVStore,
  snapshots: StockSnapshot[],
): Promise<StockSnapshot | null> {
  const wanted = await kv.get(KV_KEYS.forceAlert);
  if (wanted === null || wanted.trim() === '') return null;
  // Always clear, even when the id matches nothing: a flag naming a variant that no longer
  // exists would otherwise re-read on every pass forever.
  await kv.delete(KV_KEYS.forceAlert);
  const match = snapshots.find((s) => s.variantId === wanted.trim());
  return match ?? null;
}

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

  // Backing off after a 429 means sending NOTHING, not sending less. One KV read decides it, and
  // a suspended pass performs no fetch and no write -- so a throttle is cheaper than normal
  // operation, which is what lets the store's rate-limit window actually drain.
  const backoff = await checkBackoff(deps.kv, deps.now);
  if (backoff.active) {
    const reason =
      `rate limited; polling suspended until ${new Date(backoff.until ?? deps.now).toISOString()}` +
      (backoff.reason === null ? '' : ` (${backoff.reason})`);
    // Quiet is not the same as silent. If blindness has outlasted BLIND_PAGE_AFTER_MS, this pass
    // still pages -- otherwise a long throttle would look exactly like a healthy sold-out store.
    const detectorDispatch = backoff.pageDue
      ? await dispatchDetectorPage({
          kv: deps.kv,
          fetchImpl: deps.fetchImpl,
          now: deps.now,
          accessToken: deps.accessToken,
          kind: 'detector-down',
          consecutiveFailures: backoff.consecutiveFailures,
          reason,
        })
      : null;
    return {
      ok: false,
      adapter: null,
      reason,
      alerts: 0,
      dispatch: null,
      detectorPage: backoff.pageDue ? 'detector-down' : null,
      detectorDispatch,
      rateLimitedUntil: backoff.until,
      skipped: true,
    };
  }

  const result = await detect({
    productUrl,
    config: deps.config ?? detectConfig,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });

  if (!result.ok && result.rateLimited === true) {
    // Still invariant 1: no variant state, no snapshot cache, no restock push. The only
    // difference from an ordinary failure is that we now also stop knocking for a while.
    const { until, consecutiveFailures, pageDue } = await recordRateLimited(
      deps.kv,
      result.reason,
      result.retryAfterMs ?? null,
      deps.now,
    );
    console.warn(
      `[astra] rate limited by store; suspending polls until ${new Date(until).toISOString()}`,
    );
    const detectorDispatch = pageDue
      ? await dispatchDetectorPage({
          kv: deps.kv,
          fetchImpl: deps.fetchImpl,
          now: deps.now,
          accessToken: deps.accessToken,
          kind: 'detector-down',
          consecutiveFailures,
          reason: result.reason,
        })
      : null;
    return {
      ok: false,
      adapter: null,
      reason: result.reason,
      alerts: 0,
      dispatch: null,
      detectorPage: pageDue ? 'detector-down' : null,
      detectorDispatch,
      rateLimitedUntil: until,
      skipped: false,
    };
  }

  if (!result.ok) {
    const { consecutiveFailures, pageDue } = await recordFailure(deps.kv, result.reason, deps.now);
    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      console.warn(
        `[astra] detector unhealthy: ${consecutiveFailures} consecutive failures. Last: ${result.reason}`,
      );
    }
    // A broken detector used to be silent, which the user reads as "not in stock yet" -- the one
    // conclusion it does not support. `recordFailure` has already applied the threshold and the
    // page cooldown, so this branch only sends. It still writes nothing but health and still
    // sends no restock push: invariant 1 is untouched by paging.
    const detectorDispatch = pageDue
      ? await dispatchDetectorPage({
          kv: deps.kv,
          fetchImpl: deps.fetchImpl,
          now: deps.now,
          accessToken: deps.accessToken,
          kind: 'detector-down',
          consecutiveFailures,
          reason: result.reason,
        })
      : null;
    return {
      ok: false,
      adapter: null,
      reason: result.reason,
      alerts: 0,
      dispatch: null,
      detectorPage: pageDue ? 'detector-down' : null,
      detectorDispatch,
      rateLimitedUntil: null,
      skipped: false,
    };
  }

  const { alerts } = await applySnapshots(deps.kv, result.snapshots, deps.now);

  // One-shot test trigger. Reached only on a SUCCESSFUL pass, so invariant 1 is untouched: a
  // failing detect still returns above without consuming the flag, and a debug path must not be
  // the thing that weakens the guarantee the rest of this file is built around.
  //
  // Deliberately bypasses both the latch and the cooldown -- firing unconditionally is the whole
  // point. It exists because nothing else can prove delivery while the product is sold out.
  const forced = await consumeForceAlert(deps.kv, result.snapshots);
  if (forced !== null) alerts.push(forced);
  await cacheSnapshots(deps.kv, result.snapshots, deps.now);
  const { recoveryNoticeDue, heartbeatDue } = await recordSuccess(deps.kv, result.adapter, deps.now);

  // Close the loop only for an outage the user was actually paged about; `recordSuccess` has
  // already cleared the flag, so this fires once per outage rather than once per pass.
  const detectorDispatch = recoveryNoticeDue
    ? await dispatchDetectorPage({
        kv: deps.kv,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
        accessToken: deps.accessToken,
        kind: 'detector-recovered',
        consecutiveFailures: 0,
        reason: null,
      })
    : null;

  // Proof of life. Only on a successful pass -- a heartbeat sent while the store is unreadable
  // would assert exactly the thing that is not true. `dispatchHeartbeat` is silent when nobody
  // is registered, which is the case this whole feature exists to make visible.
  if (heartbeatDue) {
    await dispatchHeartbeat({
      kv: deps.kv,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      accessToken: deps.accessToken,
      variantCount: result.snapshots.length,
      lastSuccessAt: deps.now,
    });
  }

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
    detectorPage: recoveryNoticeDue ? 'detector-recovered' : null,
    detectorDispatch,
    rateLimitedUntil: null,
    skipped: false,
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
  const [health, cache, devices] = await Promise.all([
    readHealth(kv),
    readSnapshotCache(kv),
    readRegistry(kv),
  ]);
  return {
    snapshots: cache?.snapshots ?? [],
    lastSuccessAt: health?.lastSuccessAt ?? null,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    adapter: health?.lastAdapter ?? null,
    // Zero here means a restock would be detected perfectly and delivered to nobody. Every other
    // field would still read healthy, which is why this one is worth a round trip.
    registeredDevices: devices.length,
    // Reporting a problem without its cause just sends the reader to wrangler.
    lastReason: health?.lastReason ?? null,
    rateLimitedUntil: health?.rateLimitedUntil ?? null,
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
