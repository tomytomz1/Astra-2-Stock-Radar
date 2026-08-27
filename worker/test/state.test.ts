import { describe, expect, it } from 'vitest';
import { ALERT_COOLDOWN_MS, FAILURE_ALERT_THRESHOLD, KV_KEYS } from '@astra/contract';
import type { StockSnapshot, VariantState } from '@astra/contract';
import {
  applySnapshots,
  cacheSnapshots,
  HEALTH_REFRESH_MS,
  recordFailure,
  recordSuccess,
} from '../src/state';
import { FakeKV } from './helpers';

const NOW = 1_772_000_000_000;
const VARIANT = '44892134567001';
const KEY = KV_KEYS.variantState(VARIANT);

function snapshot(available: boolean, overrides: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    variantId: VARIANT,
    title: 'Silver / 16GB + 512GB',
    available,
    priceCents: 89900,
    currency: 'USD',
    checkedAt: NOW,
    ...overrides,
  };
}

function state(overrides: Partial<VariantState> = {}): VariantState {
  return { available: false, lastAlertedAt: null, lastChangedAt: NOW - 60_000, ...overrides };
}

describe('applySnapshots — the latch', () => {
  it('fires exactly one alert on false -> true and records lastAlertedAt', async () => {
    const kv = new FakeKV({ [KEY]: state({ available: false }) });
    const { alerts } = await applySnapshots(kv, [snapshot(true)], NOW);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.variantId).toBe(VARIANT);
    expect(kv.writes).toBe(1);
    expect(kv.read<VariantState>(KEY)).toEqual({
      available: true,
      lastAlertedAt: NOW,
      lastChangedAt: NOW,
    });
  });

  it('fires on the FIRST observed true with no prior state (no confirmation pass)', async () => {
    const kv = new FakeKV();
    const { alerts } = await applySnapshots(kv, [snapshot(true)], NOW);

    expect(alerts).toHaveLength(1);
    expect(kv.read<VariantState>(KEY)?.lastAlertedAt).toBe(NOW);
  });

  it('sends nothing and writes nothing on true -> true', async () => {
    const kv = new FakeKV({ [KEY]: state({ available: true, lastAlertedAt: NOW - 1000 }) });
    const { alerts } = await applySnapshots(kv, [snapshot(true)], NOW);

    expect(alerts).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  it('sends nothing but updates state on true -> false', async () => {
    const kv = new FakeKV({ [KEY]: state({ available: true, lastAlertedAt: NOW - 1000 }) });
    const { alerts } = await applySnapshots(kv, [snapshot(false)], NOW);

    expect(alerts).toHaveLength(0);
    expect(kv.writes).toBe(1);
    expect(kv.read<VariantState>(KEY)).toEqual({
      available: false,
      lastAlertedAt: NOW - 1000,
      lastChangedAt: NOW,
    });
  });

  it('performs ZERO writes in the steady state (false -> false)', async () => {
    const kv = new FakeKV({ [KEY]: state({ available: false }) });
    for (let pass = 0; pass < 10; pass += 1) {
      await applySnapshots(kv, [snapshot(false)], NOW + pass * 60_000);
    }
    expect(kv.writes).toBe(0);
  });

  it('suppresses a second alert inside ALERT_COOLDOWN_MS and permits one after it', async () => {
    const kv = new FakeKV({
      [KEY]: state({ available: false, lastAlertedAt: NOW - (ALERT_COOLDOWN_MS - 1000) }),
    });
    const suppressed = await applySnapshots(kv, [snapshot(true)], NOW);
    expect(suppressed.alerts).toHaveLength(0);
    // State still moves to available (that is not an alert), so exactly one write.
    expect(kv.writes).toBe(1);
    expect(kv.read<VariantState>(KEY)?.available).toBe(true);

    // Flip back to sold out, then back in stock once the cooldown has lapsed.
    const later = NOW + ALERT_COOLDOWN_MS;
    await applySnapshots(kv, [snapshot(false)], later - 1000);
    const permitted = await applySnapshots(kv, [snapshot(true)], later);
    expect(permitted.alerts).toHaveLength(1);
    expect(kv.read<VariantState>(KEY)?.lastAlertedAt).toBe(later);
  });

  it('latches each variant independently', async () => {
    const kv = new FakeKV();
    const { alerts } = await applySnapshots(
      kv,
      [
        snapshot(true, { variantId: 'a', title: 'A' }),
        snapshot(false, { variantId: 'b', title: 'B' }),
      ],
      NOW,
    );
    expect(alerts.map((a) => a.variantId)).toEqual(['a']);
    expect(kv.writes).toBe(2); // both are first observations
    expect(kv.read<VariantState>(KV_KEYS.variantState('b'))?.available).toBe(false);
  });
});

describe('health state', () => {
  it('writes on the first success then stays silent while nothing changes', async () => {
    const kv = new FakeKV();
    expect(await recordSuccess(kv, 'shopify-js', NOW)).toBe(true);
    kv.resetCounters();

    for (let pass = 1; pass * 60_000 < HEALTH_REFRESH_MS; pass += 1) {
      await recordSuccess(kv, 'shopify-js', NOW + pass * 60_000);
    }
    expect(kv.writes).toBe(0);
  });

  it('refreshes lastSuccessAt at most once per HEALTH_REFRESH_MS', async () => {
    const kv = new FakeKV();
    await recordSuccess(kv, 'shopify-js', NOW);
    kv.resetCounters();
    expect(await recordSuccess(kv, 'shopify-js', NOW + HEALTH_REFRESH_MS)).toBe(true);
    expect(kv.writes).toBe(1);
  });

  it('writes when the adapter changes or after a recovery', async () => {
    const kv = new FakeKV();
    await recordSuccess(kv, 'shopify-js', NOW);
    kv.resetCounters();
    expect(await recordSuccess(kv, 'jsonld', NOW + 60_000)).toBe(true);

    await recordFailure(kv, 'store down', NOW + 120_000);
    kv.resetCounters();
    expect(await recordSuccess(kv, 'jsonld', NOW + 180_000)).toBe(true);
    expect(kv.read<{ consecutiveFailures: number }>(KV_KEYS.health)?.consecutiveFailures).toBe(0);
  });

  it('keeps counting failures up to the alert threshold, then throttles writes', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= FAILURE_ALERT_THRESHOLD; i += 1) {
      const result = await recordFailure(kv, 'HTTP 503', NOW + i * 60_000);
      expect(result.consecutiveFailures).toBe(i);
      expect(result.wrote).toBe(true);
    }
    kv.resetCounters();

    // Past the threshold the counter still climbs but KV is only touched hourly.
    const justAfter = await recordFailure(kv, 'HTTP 503', NOW);
    expect(justAfter.consecutiveFailures).toBe(FAILURE_ALERT_THRESHOLD + 1);
    expect(justAfter.wrote).toBe(false);
    expect(kv.writes).toBe(0);
  });

  it('never advances lastSuccessAt on failure', async () => {
    const kv = new FakeKV();
    await recordSuccess(kv, 'shopify-js', NOW);
    await recordFailure(kv, 'HTTP 500', NOW + 60_000);
    expect(kv.read<{ lastSuccessAt: number }>(KV_KEYS.health)?.lastSuccessAt).toBe(NOW);
  });
});

describe('snapshot cache', () => {
  it('writes once, then not again while only checkedAt moves', async () => {
    const kv = new FakeKV();
    expect(await cacheSnapshots(kv, [snapshot(false)], NOW)).toBe(true);
    kv.resetCounters();

    expect(await cacheSnapshots(kv, [snapshot(false, { checkedAt: NOW + 60_000 })], NOW + 60_000)).toBe(
      false,
    );
    expect(kv.writes).toBe(0);
  });

  it('writes when availability or price changes', async () => {
    const kv = new FakeKV();
    await cacheSnapshots(kv, [snapshot(false)], NOW);
    kv.resetCounters();
    expect(await cacheSnapshots(kv, [snapshot(true)], NOW)).toBe(true);
    expect(await cacheSnapshots(kv, [snapshot(true, { priceCents: 79900 })], NOW)).toBe(true);
    expect(kv.writes).toBe(2);
  });
});
