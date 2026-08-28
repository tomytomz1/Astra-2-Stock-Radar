import { describe, expect, it } from 'vitest';
import {
  ANDROID_CHANNEL_DETECTOR,
  ANDROID_CHANNEL_RESTOCK,
  EXPO_PUSH_SEND_URL,
  HEARTBEAT_INTERVAL_MS,
  KV_KEYS,
} from '@astra/contract';
import type { DetectConfig, HealthState, RegisteredDevice, VariantState } from '@astra/contract';
import { runPass } from '../src/index';
import { buildHeartbeatMessages, heartbeatBody } from '../src/dispatch';
import { recordSuccess } from '../src/state';
import { FakeKV, errorResponse, fakeFetch, jsonFixture, jsonResponse } from './helpers';

/**
 * The weekly liveness heartbeat.
 *
 * It exists for one failure mode: a push token is invalidated, the Worker correctly prunes it on
 * the `DeviceNotRegistered` receipt, and the registry is now empty. Every other signal still
 * reads healthy — the cron fires, detection succeeds, `/status` shows zero failures — and a
 * restock would be detected perfectly and delivered to nobody. Without a ping that stops
 * arriving, that state is indistinguishable from a working system for months.
 */

const NOW = 1_772_000_000_000;
const WEEK = HEARTBEAT_INTERVAL_MS;

const CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

function device(token: string): RegisteredDevice {
  return { token, variantIds: [], platform: 'ios', registeredAt: NOW - 10_000 };
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

function kvWith(healthState: HealthState, devices: RegisteredDevice[] = [device('ExponentPushToken[watcher]')]): FakeKV {
  const state: VariantState = { available: false, lastAlertedAt: null, lastChangedAt: NOW - 5000 };
  return new FakeKV({
    [KV_KEYS.tokenRegistry]: devices,
    [KV_KEYS.health]: healthState,
    [KV_KEYS.variantState('44892134567001')]: state,
    [KV_KEYS.variantState('44892134567002')]: state,
    [KV_KEYS.variantState('44892134567003')]: state,
  });
}

const store = () => fakeFetch(() => jsonResponse(jsonFixture('shopify-js.soldout.json')));

describe('liveness heartbeat', () => {
  it('does not fire on the first pass after deploy — it starts the clock instead', async () => {
    const kv = kvWith(health({ lastHeartbeatAt: null }));

    const first = store();
    await runPass({ kv, fetchImpl: first.fetchImpl, now: NOW, config: CONFIG });
    expect(first.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);

    // The clock is seeded by the next health write rather than immediately: `recordSuccess`
    // skips writing when nothing material changed, which is invariant 3 doing its job. Health is
    // refreshed on staleness within minutes, so seeding is prompt without costing an extra write.
    const later = NOW + 10 * 60_000;
    const second = store();
    await runPass({ kv, fetchImpl: second.fetchImpl, now: later, config: CONFIG });
    expect(second.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastHeartbeatAt).toBe(later);
  });

  it('does not fire before the interval has elapsed', async () => {
    const kv = kvWith(health({ lastHeartbeatAt: NOW - WEEK + 60_000 }));
    const http = store();
    await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('fires once the interval has elapsed, and records the time so the next pass is silent', async () => {
    const kv = kvWith(health({ lastHeartbeatAt: NOW - WEEK }));

    const first = store();
    await runPass({ kv, fetchImpl: first.fetchImpl, now: NOW, config: CONFIG });
    expect(first.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(1);
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastHeartbeatAt).toBe(NOW);

    const second = store();
    await runPass({ kv, fetchImpl: second.fetchImpl, now: NOW + 60_000, config: CONFIG });
    expect(second.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('is silent when no device is registered — there is nobody to tell', async () => {
    const kv = kvWith(health({ lastHeartbeatAt: NOW - WEEK }), []);
    const http = store();
    await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('a failing pass sends no heartbeat and does not advance the clock', async () => {
    // A heartbeat while the store is unreadable would assert precisely the thing that is false.
    const kv = kvWith(health({ lastHeartbeatAt: NOW - WEEK }));
    const down = fakeFetch(() => errorResponse(503));
    await runPass({ kv, fetchImpl: down.fetchImpl, now: NOW, config: CONFIG });

    expect(down.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    expect(kv.read<HealthState>(KV_KEYS.health)?.lastHeartbeatAt).toBe(NOW - WEEK);
  });

  it('rides the detector channel, never the restock one', async () => {
    // A weekly "still working" ping on the restock channel would train the reader to swipe away
    // the one sound that matters.
    const messages = buildHeartbeatMessages([device('ExponentPushToken[a]')], 4, NOW - 30_000, NOW);
    expect(messages[0]?.channelId).toBe(ANDROID_CHANNEL_DETECTOR);
    expect(messages[0]?.channelId).not.toBe(ANDROID_CHANNEL_RESTOCK);
    expect(messages[0]?.priority).toBe('normal');
    expect(messages[0]?.interruptionLevel).toBeUndefined();
  });

  it('carries checkable evidence rather than reassurance', async () => {
    // "Everything is fine" would be equally true of a watcher that stopped reading an hour ago.
    const body = heartbeatBody(4, NOW - 30_000, NOW);
    expect(body).toContain('4 variants');
    expect(body).toContain('30s ago');
  });

  it('recordSuccess reports the heartbeat without an extra KV read', async () => {
    const kv = kvWith(health({ lastHeartbeatAt: NOW - WEEK }));
    kv.resetCounters();
    const result = await recordSuccess(kv, 'shopify-js', NOW);
    expect(result.heartbeatDue).toBe(true);
    // One read of the health record — the same one `recordSuccess` already needed.
    expect(kv.reads).toBe(1);
  });
});
