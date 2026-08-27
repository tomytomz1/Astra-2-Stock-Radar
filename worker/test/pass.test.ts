import { describe, expect, it } from 'vitest';
import { EXPO_PUSH_SEND_URL, KV_KEYS, PRODUCT_URL } from '@astra/contract';
import type { DetectConfig, RegisteredDevice, VariantState } from '@astra/contract';
import { runPass } from '../src/index';
import { HEALTH_REFRESH_MS, SNAPSHOT_CACHE_KEY } from '../src/state';
import { FakeKV, errorResponse, fakeFetch, jsonFixture, jsonResponse } from './helpers';

const NOW = 1_772_000_000_000;
const CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

const SILVER = KV_KEYS.variantState('44892134567001');
const SILVER_1TB = KV_KEYS.variantState('44892134567002');
const MIDNIGHT = KV_KEYS.variantState('44892134567003');

const DEVICE: RegisteredDevice = {
  token: 'ExponentPushToken[watcher]',
  variantIds: [],
  platform: 'ios',
  registeredAt: NOW - 10_000,
};

function soldOutEverywhere(): FakeKV {
  const soldOut: VariantState = { available: false, lastAlertedAt: null, lastChangedAt: NOW - 1000 };
  return new FakeKV({
    [SILVER]: soldOut,
    [SILVER_1TB]: soldOut,
    [MIDNIGHT]: soldOut,
    [KV_KEYS.tokenRegistry]: [DEVICE],
    [KV_KEYS.health]: {
      lastSuccessAt: NOW - 1000,
      consecutiveFailures: 0,
      lastAdapter: 'shopify-js',
      lastReason: null,
    },
  });
}

/** Serves the sold-out `.js` fixture; Expo endpoints answer with empty success payloads. */
function storeFetch(payload: unknown) {
  return fakeFetch((url) => {
    if (url.startsWith(PRODUCT_URL)) return jsonResponse(payload);
    return jsonResponse({ data: [] });
  });
}

describe('runPass — invariant 1: a failed fetch is not "out of stock"', () => {
  it('leaves every variant state untouched and sends nothing when the chain fails', async () => {
    const kv = soldOutEverywhere();
    // Pretend the silver variant was IN STOCK when we last saw the store.
    await kv.put(SILVER, JSON.stringify({ available: true, lastAlertedAt: NOW - 5000, lastChangedAt: NOW - 5000 }));
    const before = new Map(kv.store);
    kv.resetCounters();

    const http = fakeFetch(() => errorResponse(503));
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.ok).toBe(false);
    expect(summary.alerts).toBe(0);
    expect(summary.dispatch).toBeNull();

    // The ONLY key written is the health counter.
    expect(kv.writeKeys).toEqual([KV_KEYS.health]);
    expect(kv.read<VariantState>(SILVER)).toEqual(JSON.parse(before.get(SILVER) as string));
    expect(kv.read<VariantState>(MIDNIGHT)).toEqual(JSON.parse(before.get(MIDNIGHT) as string));
    expect(kv.store.get(SNAPSHOT_CACHE_KEY)).toBeUndefined();

    // No push was attempted.
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);

    const health = kv.read<{ consecutiveFailures: number; lastSuccessAt: number }>(KV_KEYS.health);
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.lastSuccessAt).toBe(NOW - 1000);
  });

  it('does not produce a phantom alert when the store recovers after an outage', async () => {
    // The regression this whole design exists to prevent: variant is genuinely SOLD OUT, the
    // store goes down for a few passes, then comes back still sold out. If the outage had been
    // recorded as `available: false` -> and recovery as a change -> we would alert on nothing.
    const kv = soldOutEverywhere();
    kv.resetCounters();

    const down = fakeFetch(() => errorResponse(500));
    for (let pass = 0; pass < 3; pass += 1) {
      await runPass({ kv, fetchImpl: down.fetchImpl, now: NOW + pass * 60_000, config: CONFIG });
    }

    const up = storeFetch(jsonFixture('shopify-js.soldout.json'));
    const summary = await runPass({ kv, fetchImpl: up.fetchImpl, now: NOW + 180_000, config: CONFIG });

    expect(summary.ok).toBe(true);
    expect(summary.alerts).toBe(0);
    expect(up.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    expect(kv.writeKeys.filter((key) => key.startsWith('state:variant:'))).toEqual([]);
  });
});

describe('runPass — invariant 3: steady state costs zero writes', () => {
  it('writes nothing at all when nothing changed', async () => {
    const kv = soldOutEverywhere();
    const http = storeFetch(jsonFixture('shopify-js.soldout.json'));

    // First pass populates the snapshot cache.
    await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });
    kv.resetCounters();

    for (let pass = 1; pass * 60_000 < HEALTH_REFRESH_MS; pass += 1) {
      const summary = await runPass({
        kv,
        fetchImpl: http.fetchImpl,
        now: NOW + pass * 60_000,
        config: CONFIG,
      });
      expect(summary.ok).toBe(true);
    }
    expect(kv.writes).toBe(0);
    expect(kv.reads).toBeGreaterThan(0);
  });

  it('stays inside the 1000 writes/day free-tier limit across a full day of passes', async () => {
    const kv = soldOutEverywhere();
    const http = storeFetch(jsonFixture('shopify-js.soldout.json'));

    // 1440 passes = one day of the 1-minute cron, with the store never changing.
    for (let pass = 0; pass < 1440; pass += 1) {
      await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW + pass * 60_000, config: CONFIG });
    }

    // Only the periodic health refresh (plus the first snapshot-cache write) may spend writes.
    expect(kv.writes).toBeLessThan(1000);
    expect(kv.writes).toBeLessThanOrEqual(1440 / (HEALTH_REFRESH_MS / 60_000) + 2);
    expect(kv.writeKeys.filter((key) => key.startsWith('state:variant:'))).toEqual([]);
  });
});

describe('runPass — invariant 2: the latch fires on the first observed true', () => {
  it('alerts once on a restock and stays quiet on the following passes', async () => {
    const kv = soldOutEverywhere();
    const soldOut = storeFetch(jsonFixture('shopify-js.soldout.json'));
    await runPass({ kv, fetchImpl: soldOut.fetchImpl, now: NOW, config: CONFIG });

    // The silver variant comes back in stock.
    const inStock = fakeFetch((url) => {
      if (url.startsWith(PRODUCT_URL)) return jsonResponse(jsonFixture('shopify-js.available.json'));
      if (url === EXPO_PUSH_SEND_URL) return jsonResponse({ data: [{ status: 'ok', id: 't1' }] });
      return jsonResponse({ data: {} });
    });

    const summary = await runPass({
      kv,
      fetchImpl: inStock.fetchImpl,
      now: NOW + 60_000,
      config: CONFIG,
    });

    expect(summary.ok).toBe(true);
    expect(summary.adapter).toBe('shopify-js');
    expect(summary.alerts).toBe(1);
    expect(summary.dispatch?.messages).toBe(1);

    const sends = inStock.callsTo(EXPO_PUSH_SEND_URL);
    expect(sends).toHaveLength(1);
    const messages = sends[0]?.body as { title: string; data: unknown }[];
    expect(messages[0]?.title).toContain('Silver / 16GB + 512GB');
    expect(messages[0]?.data).toEqual({
      kind: 'restock',
      variantId: '44892134567001',
      url: PRODUCT_URL,
    });

    // Second pass with the same in-stock page: true -> true, no alert, no push.
    const again = fakeFetch((url) => {
      if (url.startsWith(PRODUCT_URL)) return jsonResponse(jsonFixture('shopify-js.available.json'));
      return jsonResponse({ data: [] });
    });
    const second = await runPass({
      kv,
      fetchImpl: again.fetchImpl,
      now: NOW + 120_000,
      config: CONFIG,
    });
    expect(second.alerts).toBe(0);
    expect(again.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });
});
