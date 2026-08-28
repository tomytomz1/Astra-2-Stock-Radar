import { describe, expect, it } from 'vitest';
import {
  ANDROID_CHANNEL_DETECTOR,
  DETECTOR_PAGE_COOLDOWN_MS,
  EXPO_PUSH_BATCH_SIZE,
  EXPO_PUSH_RECEIPT_URL,
  EXPO_PUSH_SEND_URL,
  FAILURE_ALERT_THRESHOLD,
  KV_KEYS,
  PRODUCT_URL,
} from '@astra/contract';
import type {
  DetectConfig,
  DetectorPushData,
  HealthState,
  RegisteredDevice,
  VariantState,
} from '@astra/contract';
import { runPass } from '../src/index';
import { buildDetectorMessages, dispatchDetectorPage } from '../src/dispatch';
import { recordFailure, recordSuccess, SNAPSHOT_CACHE_KEY } from '../src/state';
import {
  FakeKV,
  errorResponse,
  fakeFetch,
  jsonFixture,
  jsonResponse,
  type FakeFetch,
} from './helpers';

const NOW = 1_772_000_000_000;
const MINUTE = 60_000;

const CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

const SILVER = KV_KEYS.variantState('44892134567001');
const SILVER_1TB = KV_KEYS.variantState('44892134567002');
const MIDNIGHT = KV_KEYS.variantState('44892134567003');

function device(token: string, variantIds: string[] = []): RegisteredDevice {
  return { token, variantIds, platform: 'ios', registeredAt: NOW - 10_000 };
}

function health(overrides: Partial<HealthState> = {}): HealthState {
  return {
    lastSuccessAt: NOW - 1000,
    consecutiveFailures: 0,
    lastAdapter: 'shopify-js',
    lastReason: null,
    lastPagedAt: null,
    lastHeartbeatAt: null,
    rateLimitedUntil: null,
    rateLimitStreak: 0,
    ...overrides,
  };
}

/** Sold out everywhere, one device subscribed to everything, detector healthy. */
function seededKv(
  devices: RegisteredDevice[] = [device('ExponentPushToken[watcher]')],
  healthState: unknown = health(),
): FakeKV {
  const soldOut: VariantState = { available: false, lastAlertedAt: null, lastChangedAt: NOW - 1000 };
  return new FakeKV({
    [SILVER]: soldOut,
    [SILVER_1TB]: soldOut,
    [MIDNIGHT]: soldOut,
    [KV_KEYS.tokenRegistry]: devices,
    [KV_KEYS.health]: healthState,
  });
}

/** The store is unreachable; Expo accepts everything we send it. */
function storeDown(): FakeFetch {
  return fakeFetch((url, init) => {
    if (url.startsWith(PRODUCT_URL)) return errorResponse(503);
    if (url === EXPO_PUSH_SEND_URL) {
      const batch = JSON.parse(init?.body ?? '[]') as unknown[];
      return jsonResponse({ data: batch.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })) });
    }
    return jsonResponse({ data: {} });
  });
}

/** The store is readable again and everything is still sold out. */
function storeUp(): FakeFetch {
  return fakeFetch((url, init) => {
    if (url.startsWith(PRODUCT_URL)) return jsonResponse(jsonFixture('shopify-js.soldout.json'));
    if (url === EXPO_PUSH_SEND_URL) {
      const batch = JSON.parse(init?.body ?? '[]') as unknown[];
      return jsonResponse({ data: batch.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })) });
    }
    return jsonResponse({ data: {} });
  });
}

interface SentMessage {
  to: string;
  title: string;
  body: string;
  data: DetectorPushData;
  priority: string;
  channelId: string;
}

function sentMessages(http: FakeFetch): SentMessage[] {
  return http.callsTo(EXPO_PUSH_SEND_URL).flatMap((call) => call.body as SentMessage[]);
}

async function failFor(kv: FakeKV, http: FakeFetch, passes: number, startPass = 0) {
  const summaries = [];
  for (let i = 0; i < passes; i += 1) {
    summaries.push(
      await runPass({
        kv,
        fetchImpl: http.fetchImpl,
        now: NOW + (startPass + i) * MINUTE,
        config: CONFIG,
      }),
    );
  }
  return summaries;
}

describe('detector paging — when it fires', () => {
  it('pages exactly once, on the pass that crosses FAILURE_ALERT_THRESHOLD', async () => {
    const kv = seededKv();
    const http = storeDown();

    const summaries = await failFor(kv, http, FAILURE_ALERT_THRESHOLD + 5);

    const paged = summaries.filter((s) => s.detectorPage === 'detector-down');
    expect(paged).toHaveLength(1);
    // Index is zero-based, so the 15th pass is index 14.
    expect(summaries[FAILURE_ALERT_THRESHOLD - 1]?.detectorPage).toBe('detector-down');

    const messages = sentMessages(http);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data.kind).toBe('detector-down');
    expect(messages[0]?.data.consecutiveFailures).toBe(FAILURE_ALERT_THRESHOLD);
    // The chain's reason names every adapter that failed, so it arrives truncated.
    expect(messages[0]?.data.reason).toContain('shopify-js: HTTP 503');
    expect((messages[0]?.data.reason ?? '').length).toBeLessThanOrEqual(140);
    expect(messages[0]?.title).toContain('DOWN');
    expect(messages[0]?.body).toContain(`${FAILURE_ALERT_THRESHOLD} consecutive checks`);
    expect(messages[0]?.body).toContain('not in stock');
    expect(messages[0]?.body).toContain('HTTP 503');

    // A page is a state change, so it is persisted -- that is what makes it fire only once.
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastPagedAt).toBe(
      NOW + (FAILURE_ALERT_THRESHOLD - 1) * MINUTE,
    );
  });

  it('stays silent below the threshold', async () => {
    const kv = seededKv();
    const http = storeDown();

    const summaries = await failFor(kv, http, FAILURE_ALERT_THRESHOLD - 1);

    expect(summaries.every((s) => s.detectorPage === null)).toBe(true);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastPagedAt).toBeNull();
  });

  it('reads a legacy health record with no lastPagedAt field as "never paged"', async () => {
    // Records written before `lastPagedAt` existed must not be read as `undefined !== null`.
    const legacy = {
      lastSuccessAt: NOW - 1000,
      consecutiveFailures: FAILURE_ALERT_THRESHOLD - 1,
      lastAdapter: 'shopify-js',
      lastReason: 'HTTP 503',
    };
    const kv = seededKv([device('ExponentPushToken[watcher]')], legacy);
    const http = storeDown();

    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.detectorPage).toBe('detector-down');
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastPagedAt).toBe(NOW);
  });
});

describe('detector paging — the cooldown', () => {
  it('does not page again inside DETECTOR_PAGE_COOLDOWN_MS of a sustained outage', async () => {
    const kv = seededKv(
      [device('ExponentPushToken[watcher]')],
      health({ consecutiveFailures: FAILURE_ALERT_THRESHOLD + 40, lastPagedAt: NOW - MINUTE }),
    );
    const http = storeDown();

    const summaries = await failFor(kv, http, 10);

    expect(summaries.every((s) => s.detectorPage === null)).toBe(true);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    // The page we already sent is still recorded; a throttled write must not lose it.
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastPagedAt).toBe(NOW - MINUTE);
  });

  it('pages again once the cooldown has elapsed and the outage is still going', async () => {
    const kv = seededKv(
      [device('ExponentPushToken[watcher]')],
      health({
        consecutiveFailures: 400,
        lastPagedAt: NOW - DETECTOR_PAGE_COOLDOWN_MS,
        lastReason: 'HTTP 503',
      }),
    );
    const http = storeDown();

    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.detectorPage).toBe('detector-down');
    expect(sentMessages(http)[0]?.data.consecutiveFailures).toBe(401);
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastPagedAt).toBe(NOW);
  });

  it('pages twice, not 705 times, across a 12-hour outage at one pass per minute', async () => {
    const kv = new FakeKV({ [KV_KEYS.health]: health() });
    const pagedAt: number[] = [];

    for (let pass = 1; pass <= 12 * 60; pass += 1) {
      const now = NOW + pass * MINUTE;
      const result = await recordFailure(kv, 'HTTP 503', now);
      if (result.pageDue) pagedAt.push(now);
    }

    // First page on the threshold pass, then one more when the 6h cooldown lapses.
    expect(pagedAt).toEqual([
      NOW + FAILURE_ALERT_THRESHOLD * MINUTE,
      NOW + FAILURE_ALERT_THRESHOLD * MINUTE + DETECTOR_PAGE_COOLDOWN_MS,
    ]);
    // Invariant 3: a 12-hour outage still costs the threshold writes plus hourly throttled ones.
    expect(kv.writes).toBeLessThan(50);
  });
});

describe('detector paging — recovery', () => {
  it('sends detector-recovered after a paged outage and clears lastPagedAt', async () => {
    const kv = seededKv();
    const down = storeDown();
    await failFor(kv, down, FAILURE_ALERT_THRESHOLD);
    expect(sentMessages(down)).toHaveLength(1);

    const up = storeUp();
    const summary = await runPass({
      kv,
      fetchImpl: up.fetchImpl,
      now: NOW + FAILURE_ALERT_THRESHOLD * MINUTE,
      config: CONFIG,
    });

    expect(summary.ok).toBe(true);
    expect(summary.detectorPage).toBe('detector-recovered');
    expect(summary.alerts).toBe(0);

    const messages = sentMessages(up);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.title).toContain('back');
    expect(messages[0]?.data).toEqual({
      kind: 'detector-recovered',
      consecutiveFailures: 0,
      reason: null,
    });

    expect(kv.read<HealthState>(KV_KEYS.health)?.lastPagedAt).toBeNull();

    // And it fires once: the next healthy pass says nothing.
    const quiet = storeUp();
    const second = await runPass({
      kv,
      fetchImpl: quiet.fetchImpl,
      now: NOW + (FAILURE_ALERT_THRESHOLD + 1) * MINUTE,
      config: CONFIG,
    });
    expect(second.detectorPage).toBeNull();
    expect(quiet.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('says nothing when a blip we never paged about ends', async () => {
    const kv = seededKv();
    const down = storeDown();
    await failFor(kv, down, FAILURE_ALERT_THRESHOLD - 1);

    const up = storeUp();
    const summary = await runPass({
      kv,
      fetchImpl: up.fetchImpl,
      now: NOW + FAILURE_ALERT_THRESHOLD * MINUTE,
      config: CONFIG,
    });

    // "Recovered" from an outage the user was never told about is pure noise.
    expect(summary.detectorPage).toBeNull();
    expect(up.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    expect(kv.read<HealthState>(KV_KEYS.health)?.consecutiveFailures).toBe(0);
  });

  it('recordSuccess reports the recovery exactly once at the state level', async () => {
    const kv = new FakeKV({
      [KV_KEYS.health]: health({ consecutiveFailures: 30, lastPagedAt: NOW - MINUTE }),
    });

    const first = await recordSuccess(kv, 'shopify-js', NOW);
    // `heartbeatDue` is false here because the fixture seeds `lastHeartbeatAt: null`, which
    // starts the weekly clock rather than firing on the first pass.
    expect(first).toEqual({ wrote: true, recoveryNoticeDue: true, heartbeatDue: false });

    const second = await recordSuccess(kv, 'shopify-js', NOW + MINUTE);
    expect(second.recoveryNoticeDue).toBe(false);
    expect(second.wrote).toBe(false);
  });
});

describe('detector paging — audience and shape', () => {
  it('goes to EVERY registered device, ignoring variant subscriptions', async () => {
    const devices = [
      device('ExponentPushToken[all]', []),
      device('ExponentPushToken[silver]', ['44892134567001']),
      device('ExponentPushToken[somethingelse]', ['not-a-variant-we-watch']),
    ];
    const kv = seededKv(devices);
    const http = storeDown();

    await failFor(kv, http, FAILURE_ALERT_THRESHOLD);

    expect(sentMessages(http).map((m) => m.to)).toEqual([
      'ExponentPushToken[all]',
      'ExponentPushToken[silver]',
      'ExponentPushToken[somethingelse]',
    ]);
  });

  it('is quieter than a restock and carries no tap-to-buy link', () => {
    const messages = buildDetectorMessages(
      [device('ExponentPushToken[abc]')],
      'detector-down',
      FAILURE_ALERT_THRESHOLD,
      'fetch timed out',
    );
    expect(messages[0]?.priority).toBe('normal');
    expect(messages[0]?.channelId).toBe(ANDROID_CHANNEL_DETECTOR);
    expect(messages[0]?.channelId).toBe('detector-alerts');
    expect(messages[0]?.data).not.toHaveProperty('url');
    expect(messages[0]?.data).not.toHaveProperty('variantId');
  });

  it('truncates a pathological failure reason instead of shipping a wall of HTML', () => {
    const messages = buildDetectorMessages(
      [device('ExponentPushToken[abc]')],
      'detector-down',
      20,
      'x'.repeat(5000),
    );
    const reason = messages[0]?.data.reason ?? '';
    expect(reason.length).toBeLessThanOrEqual(140);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('reuses the batching and DeviceNotRegistered pruning of the restock path', async () => {
    const devices = Array.from({ length: 250 }, (_, i) =>
      device(`ExponentPushToken[device${String(i).padStart(4, '0')}]`),
    );
    const kv = new FakeKV({ [KV_KEYS.tokenRegistry]: devices });
    let seq = 0;
    const http = fakeFetch((url, init) => {
      if (url === EXPO_PUSH_SEND_URL) {
        const batch = JSON.parse(init?.body ?? '[]') as unknown[];
        return jsonResponse({ data: batch.map(() => ({ status: 'ok', id: `t${seq++}` })) });
      }
      return jsonResponse({ data: { t0: { status: 'error', details: { error: 'DeviceNotRegistered' } } } });
    });

    const summary = await dispatchDetectorPage({
      kv,
      fetchImpl: http.fetchImpl,
      now: NOW,
      kind: 'detector-down',
      consecutiveFailures: 20,
      reason: 'HTTP 403',
    });

    const sends = http.callsTo(EXPO_PUSH_SEND_URL);
    expect(sends).toHaveLength(3);
    expect((sends[0]?.body as unknown[]).length).toBe(EXPO_PUSH_BATCH_SIZE);
    expect(summary.messages).toBe(250);
    expect(summary.accepted).toBe(250);
    expect(http.callsTo(EXPO_PUSH_RECEIPT_URL)).toHaveLength(1);
    expect(summary.prunedTokens).toBe(1);
    expect(kv.read<RegisteredDevice[]>(KV_KEYS.tokenRegistry)).toHaveLength(249);
  });

  it('sends nothing when no device is registered', async () => {
    const kv = seededKv([]);
    const http = storeDown();

    const summaries = await failFor(kv, http, FAILURE_ALERT_THRESHOLD);

    expect(summaries[FAILURE_ALERT_THRESHOLD - 1]?.detectorPage).toBe('detector-down');
    expect(summaries[FAILURE_ALERT_THRESHOLD - 1]?.detectorDispatch?.messages).toBe(0);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });
});

describe('detector paging — invariant 1 still holds', () => {
  it('a failing pass that PAGES still touches no variant state and sends no restock', async () => {
    const kv = seededKv();
    // The last thing we saw was silver IN STOCK. If a failure were ever recorded as
    // `available: false`, the store's recovery would fire a phantom restock alert.
    const wasAvailable: VariantState = {
      available: true,
      lastAlertedAt: NOW - 5000,
      lastChangedAt: NOW - 5000,
    };
    await kv.put(SILVER, JSON.stringify(wasAvailable));
    const before = new Map(kv.store);
    kv.resetCounters();

    const http = storeDown();
    const summaries = await failFor(kv, http, FAILURE_ALERT_THRESHOLD);

    expect(summaries[FAILURE_ALERT_THRESHOLD - 1]?.detectorPage).toBe('detector-down');
    expect(summaries.every((s) => s.alerts === 0 && s.dispatch === null)).toBe(true);

    // Health is the ONLY key written -- paging adds no other write.
    expect(new Set(kv.writeKeys)).toEqual(new Set([KV_KEYS.health]));
    expect(kv.read<VariantState>(SILVER)).toEqual(JSON.parse(before.get(SILVER) as string));
    expect(kv.read<VariantState>(MIDNIGHT)).toEqual(JSON.parse(before.get(MIDNIGHT) as string));
    expect(kv.store.get(SNAPSHOT_CACHE_KEY)).toBeUndefined();

    // Everything that went out was a detector page; not one restock push.
    const messages = sentMessages(http);
    expect(messages).toHaveLength(1);
    expect(messages.every((m) => m.data.kind === 'detector-down')).toBe(true);

    // And the recovery still produces no phantom alert.
    const up = storeUp();
    const recovery = await runPass({
      kv,
      fetchImpl: up.fetchImpl,
      now: NOW + FAILURE_ALERT_THRESHOLD * MINUTE,
      config: CONFIG,
    });
    expect(recovery.alerts).toBe(0);
    expect(sentMessages(up).every((m) => m.data.kind === 'detector-recovered')).toBe(true);
  });
});
