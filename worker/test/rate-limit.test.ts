import { describe, expect, it } from 'vitest';
import {
  BLIND_PAGE_AFTER_MS,
  EXPO_PUSH_SEND_URL,
  KV_KEYS,
  PRODUCT_URL,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
} from '@astra/contract';
import type { DetectConfig, HealthState, RegisteredDevice, VariantState } from '@astra/contract';
import { runPass } from '../src/index';
import { detect } from '../src/detect/index';
import { recordRateLimited } from '../src/state';
import {
  FakeKV,
  fakeFetch,
  jsonFixture,
  jsonResponse,
  rateLimitedResponse,
} from './helpers';

/**
 * HTTP 429 handling.
 *
 * This exists because of a real outage. Every adapter targets the same origin, so when the store
 * began returning 429 the chain "degraded" from `.js` to `.json` to the product page — three
 * requests per pass instead of one, tripling our rate against the host that had just asked for
 * less. The throttle then sustained itself: the harder we were throttled, the harder we knocked.
 *
 * The fix has two halves, and both are load-bearing. Abort the chain on the first 429 (a 429 is
 * a property of the host, not the path), then stop polling entirely until the window drains.
 */

const NOW = 1_772_000_000_000;

const CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

function health(overrides: Partial<HealthState> = {}): HealthState {
  return {
    lastSuccessAt: NOW - 60_000,
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

function kvWith(healthState: HealthState, devices: RegisteredDevice[] = [
  { token: 'ExponentPushToken[watcher]', variantIds: [], platform: 'ios', registeredAt: NOW - 10_000 },
]): FakeKV {
  const state: VariantState = { available: false, lastAlertedAt: null, lastChangedAt: NOW - 5000 };
  return new FakeKV({
    [KV_KEYS.tokenRegistry]: devices,
    [KV_KEYS.health]: healthState,
    [KV_KEYS.variantState('44892134567001')]: state,
  });
}

/** Throttles every request, exactly as the live store did. */
const throttled = (retryAfter?: string) => fakeFetch(() => rateLimitedResponse(retryAfter));
const healthy = () => fakeFetch(() => jsonResponse(jsonFixture('shopify-js.soldout.json')));

describe('the retry storm', () => {
  it('THE BUG: a 429 stops the chain after ONE request, not four', async () => {
    // Before the fix this sent three requests to the same origin per pass: `.js`, then `.json`,
    // then the product page — all sharing one rate-limit bucket. 180 requests/hour against a host
    // that had asked for fewer than 60.
    const http = throttled();
    const result = await detect({
      productUrl: PRODUCT_URL,
      config: CONFIG,
      fetchImpl: http.fetchImpl,
      now: NOW,
    });

    expect(result.ok).toBe(false);
    expect(http.calls).toHaveLength(1);
    if (!result.ok) {
      expect(result.rateLimited).toBe(true);
      expect(result.reason).toContain('chain aborted');
    }
  });

  it('still falls through to sibling endpoints on an ordinary failure', async () => {
    // The fallthrough is right for a 404 — that path is gone, a sibling may work. Narrowing it to
    // 429 must not cost us the degradation that makes the chain worth having.
    const http = fakeFetch((url) =>
      url.endsWith('.js')
        ? jsonResponse({ nope: true }, 404)
        : jsonResponse(jsonFixture('shopify-json.available.json')),
    );
    const result = await detect({
      productUrl: PRODUCT_URL,
      config: CONFIG,
      fetchImpl: http.fetchImpl,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.adapter).toBe('shopify-json');
    expect(http.calls.length).toBeGreaterThan(1);
  });
});

describe('backing off', () => {
  it('suspends polling, then makes NO request at all while the window is open', async () => {
    const kv = kvWith(health());

    const first = throttled();
    const one = await runPass({ kv, fetchImpl: first.fetchImpl, now: NOW, config: CONFIG });
    expect(one.ok).toBe(false);
    expect(one.rateLimitedUntil).toBe(NOW + RATE_LIMIT_BACKOFF_BASE_MS);
    expect(first.calls).toHaveLength(1);

    // The next pass is the entire point: zero requests, and — because a suspended pass changes
    // nothing — zero writes.
    kv.resetCounters();
    const second = throttled();
    const two = await runPass({
      kv,
      fetchImpl: second.fetchImpl,
      now: NOW + 30_000,
      config: CONFIG,
    });
    expect(two.skipped).toBe(true);
    expect(second.calls).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  it('resumes once the window has elapsed', async () => {
    const kv = kvWith(health({ rateLimitedUntil: NOW + 60_000, rateLimitStreak: 1 }));
    const http = healthy();
    const summary = await runPass({
      kv,
      fetchImpl: http.fetchImpl,
      now: NOW + 60_001,
      config: CONFIG,
    });

    expect(summary.skipped).toBe(false);
    expect(summary.ok).toBe(true);
    expect(http.calls.length).toBeGreaterThan(0);
  });

  it('backs off exponentially while the throttling continues', async () => {
    const kv = kvWith(health());
    const streaks = [1, 2, 3, 4];
    const seen: number[] = [];
    for (const streak of streaks) {
      const result = await recordRateLimited(kv, 'HTTP 429', null, NOW);
      seen.push(result.until - NOW);
      expect(result.streak).toBe(streak);
    }
    expect(seen).toEqual([
      RATE_LIMIT_BACKOFF_BASE_MS,
      RATE_LIMIT_BACKOFF_BASE_MS * 2,
      RATE_LIMIT_BACKOFF_BASE_MS * 4,
      RATE_LIMIT_BACKOFF_BASE_MS * 8,
    ]);
  });

  it('never waits longer than the ceiling, however long the streak', async () => {
    const kv = kvWith(health({ rateLimitStreak: 40 }));
    const result = await recordRateLimited(kv, 'HTTP 429', null, NOW);
    expect(result.until - NOW).toBe(RATE_LIMIT_BACKOFF_MAX_MS);
  });

  it('honours Retry-After when the store sends one', async () => {
    const kv = kvWith(health());
    const http = throttled('300'); // seconds
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });
    expect(summary.rateLimitedUntil).toBe(NOW + 300_000);
  });

  it('caps a Retry-After the store asks for — it does not get to decide how long we are blind', async () => {
    const kv = kvWith(health());
    const http = throttled('86400'); // a day
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });
    expect(summary.rateLimitedUntil).toBe(NOW + RATE_LIMIT_BACKOFF_MAX_MS);
  });

  it('a successful read clears the backoff and the streak', async () => {
    const kv = kvWith(health({ rateLimitedUntil: NOW - 1, rateLimitStreak: 5, consecutiveFailures: 3 }));
    const http = healthy();
    await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    const after = kv.read<HealthState>(KV_KEYS.health);
    expect(after?.rateLimitedUntil).toBeNull();
    expect(after?.rateLimitStreak).toBe(0);
  });
});

describe('quiet is not silent', () => {
  it('INVARIANT 1: a throttled pass writes no variant state and sends no restock', async () => {
    const kv = kvWith(health());
    kv.resetCounters();
    const http = throttled();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.ok).toBe(false);
    expect(summary.alerts).toBe(0);
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
    expect(kv.writeKeys).toEqual([KV_KEYS.health]);
  });

  it('pages once blindness outlasts the deadline, even though every pass was skipped', async () => {
    // The failure-count threshold is useless here: skipped passes gather no failures, so a
    // throttle could keep us blind for hours while the counter crawls. The wall clock is what
    // makes the guarantee hold.
    const kv = kvWith(
      health({
        lastSuccessAt: NOW - BLIND_PAGE_AFTER_MS - 1,
        rateLimitedUntil: NOW + 60_000,
        rateLimitStreak: 6,
        consecutiveFailures: 6,
      }),
    );
    const http = throttled();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.skipped).toBe(true);
    expect(summary.detectorPage).toBe('detector-down');
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(1);
  });

  it('stays quiet while blindness is still short', async () => {
    const kv = kvWith(
      health({
        lastSuccessAt: NOW - 60_000,
        rateLimitedUntil: NOW + 60_000,
        rateLimitStreak: 1,
      }),
    );
    const http = throttled();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.detectorPage).toBeNull();
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('does not page a brand-new deployment that has never succeeded', async () => {
    // `lastSuccessAt: null` is a worker that has not run yet, not an outage. Measuring an
    // interval from null would page on every first pass after a deploy.
    const kv = kvWith(health({ lastSuccessAt: null, rateLimitedUntil: NOW + 60_000 }));
    const http = throttled();
    const summary = await runPass({ kv, fetchImpl: http.fetchImpl, now: NOW, config: CONFIG });

    expect(summary.detectorPage).toBeNull();
    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(0);
  });

  it('reports the throttle in /status rather than making you read KV', async () => {
    const kv = kvWith(health());
    await runPass({ kv, fetchImpl: throttled().fetchImpl, now: NOW, config: CONFIG });

    const { handleStatus } = await import('../src/index');
    const status = await handleStatus(kv);
    expect(status.rateLimitedUntil).toBe(NOW + RATE_LIMIT_BACKOFF_BASE_MS);
    expect(status.lastReason).toContain('429');
  });
});
