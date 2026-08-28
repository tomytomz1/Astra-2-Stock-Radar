import { describe, expect, it } from 'vitest';
import { EXPO_PUSH_SEND_URL, KV_KEYS } from '@astra/contract';
import type { DetectConfig, RegisteredDevice, HealthState, VariantState } from '@astra/contract';
import { runPass } from '../src/index';
import { FakeKV, errorResponse, fakeFetch, jsonFixture, jsonResponse } from './helpers';

/**
 * The one-shot test trigger (`KV_KEYS.forceAlert`).
 *
 * It exists because nothing else in this system can demonstrate delivery while the product is
 * sold out: the latch only fires on a genuine false->true edge from the live store, which is
 * correct behaviour and useless for answering "has a push ever reached the phone".
 *
 * The invariant-1 case below is the important one. A debug path must not become the thing that
 * weakens the guarantee the rest of the worker is built around.
 */

const NOW = 1_772_000_000_000;

const CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

/** Matches the ids in the shopify-js sold-out fixture. */
const TARGET = '44892134567001';

function device(token: string, variantIds: string[] = []): RegisteredDevice {
  return { token, variantIds, platform: 'ios', registeredAt: NOW - 10_000 };
}

/** Everything sold out, one device subscribed to everything, detector healthy. */
function soldOutWithDevice(): FakeKV {
  const state: VariantState = { available: false, lastAlertedAt: null, lastChangedAt: NOW - 5000 };
  const health: HealthState = {
    lastSuccessAt: NOW - 1000,
    consecutiveFailures: 0,
    lastAdapter: 'shopify-js',
    lastReason: null,
    lastPagedAt: null,
    lastHeartbeatAt: null,
    rateLimitedUntil: null,
    rateLimitStreak: 0,
  };
  return new FakeKV({
    [KV_KEYS.tokenRegistry]: [device('ExponentPushToken[watcher]')],
    [KV_KEYS.health]: health,
    [KV_KEYS.variantState('44892134567001')]: state,
    [KV_KEYS.variantState('44892134567002')]: state,
    [KV_KEYS.variantState('44892134567003')]: state,
  });
}

/** The trigger holds a bare variant id, not JSON, so it bypasses the constructor's stringify. */
function setTrigger(kv: FakeKV, variantId: string): void {
  kv.store.set(KV_KEYS.forceAlert, variantId);
}

const soldOutStore = () => fakeFetch(() => jsonResponse(jsonFixture('shopify-js.soldout.json')));

describe('force-alert trigger', () => {
  it('sends one alert for the named variant even though the store reports it sold out', async () => {
    const kv = soldOutWithDevice();
    setTrigger(kv, TARGET);
    kv.resetCounters();

    const http = soldOutStore();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.ok).toBe(true);
    expect(summary.alerts).toBe(1);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(1);
  });

  it('deletes the trigger so the very next pass is silent', async () => {
    const kv = soldOutWithDevice();
    setTrigger(kv, TARGET);

    const first = soldOutStore();
    await runPass({ kv, fetchImpl: first.fetchImpl, now: NOW, config: CONFIG });
    expect(kv.store.get(KV_KEYS.forceAlert)).toBeUndefined();

    const second = soldOutStore();
    const summary = await runPass({ kv, fetchImpl: second.fetchImpl, now: NOW + 60_000, config: CONFIG });
    expect(summary.alerts).toBe(0);
    expect(second.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('is a no-op when the trigger names a variant the store does not return', async () => {
    const kv = soldOutWithDevice();
    setTrigger(kv, 'not-a-real-variant');
    kv.resetCounters();

    const http = soldOutStore();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.alerts).toBe(0);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    // Still cleared: an id matching nothing would otherwise be re-read on every pass forever.
    expect(kv.store.get(KV_KEYS.forceAlert)).toBeUndefined();
  });

  it('does nothing at all when no trigger is set', async () => {
    const kv = soldOutWithDevice();
    kv.resetCounters();

    const http = soldOutStore();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.alerts).toBe(0);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('INVARIANT 1: a failing detect ignores the trigger entirely and leaves it set', async () => {
    // The debug path must not weaken the guarantee the rest of the worker rests on. A pass that
    // could not read the store touches nothing and sends nothing — including for a forced alert.
    const kv = soldOutWithDevice();
    setTrigger(kv, TARGET);
    kv.resetCounters();

    const down = fakeFetch(() => errorResponse(503));
    const summary = await runPass({ kv, fetchImpl: down.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.ok).toBe(false);
    expect(summary.alerts).toBe(0);
    expect(down.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    // The trigger survives, so the test still fires once the store is readable again.
    expect(kv.store.get(KV_KEYS.forceAlert)).toBe(TARGET);
    // Only health was written; no variant state, no snapshot cache.
    expect(kv.writeKeys).toEqual([KV_KEYS.health]);
  });
});
