import { describe, expect, it } from 'vitest';
import {
  ANDROID_CHANNEL_RESTOCK,
  EXPO_PUSH_BATCH_SIZE,
  EXPO_PUSH_RECEIPT_URL,
  EXPO_PUSH_SEND_URL,
  KV_KEYS,
  PRODUCT_URL,
} from '@astra/contract';
import type { RegisteredDevice, StockSnapshot } from '@astra/contract';
import { buildMessages, buildTitle, dispatch, formatPrice } from '../src/dispatch';
import { FakeKV, errorResponse, fakeFetch, jsonResponse } from './helpers';

const NOW = 1_772_000_000_000;

function snapshot(overrides: Partial<StockSnapshot> = {}): StockSnapshot {
  return {
    variantId: 'silver-16-512',
    title: 'Silver / 16GB + 512GB',
    available: true,
    priceCents: 89900,
    currency: 'USD',
    checkedAt: NOW,
    ...overrides,
  };
}

function device(token: string, variantIds: string[] = []): RegisteredDevice {
  return { token, variantIds, platform: 'ios', registeredAt: NOW - 1000 };
}

function tokens(count: number): RegisteredDevice[] {
  return Array.from({ length: count }, (_, i) =>
    device(`ExponentPushToken[device${String(i).padStart(4, '0')}]`),
  );
}

describe('message content', () => {
  it('names the variant and is actionable', () => {
    const messages = buildMessages([snapshot()], [device('ExponentPushToken[abc]')]);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.title).toBe('Astra 2 — Silver / 16GB + 512GB is IN STOCK');
    expect(message?.body).toContain('$899.00');
    expect(message?.data).toEqual({ kind: 'restock', variantId: 'silver-16-512', url: PRODUCT_URL });
    expect(message?.priority).toBe('high');
    expect(message?.sound).toBe('default');
    // The channel id must be the contract's, not a worker-local literal: the app creates the
    // channel under this exact name and Android silently downgrades a mismatch.
    expect(message?.channelId).toBe(ANDROID_CHANNEL_RESTOCK);
    expect(message?.channelId).toBe('restock-alerts');
  });

  it('drops the price from the body when the store does not expose one', () => {
    const messages = buildMessages(
      [snapshot({ priceCents: null, currency: null })],
      [device('ExponentPushToken[abc]')],
    );
    expect(messages[0]?.body).not.toMatch(/\d/);
    expect(buildTitle(snapshot({ title: 'Midnight / 24GB + 1TB' }))).toContain('Midnight / 24GB + 1TB');
  });

  it('falls back gracefully on an unknown currency code', () => {
    expect(formatPrice(89900, 'USD')).toBe('$899.00');
    expect(formatPrice(89900, 'NOT-A-CURRENCY')).toBe('899.00 NOT-A-CURRENCY');
    // A storefront that states no currency falls back rather than rendering a bare number:
    // the live store's `.js` endpoint does exactly this, and "899.00" in a restock alert is
    // ambiguous precisely when it matters most.
    expect(formatPrice(89900, null)).toBe('$899.00');
    expect(formatPrice(null, 'USD')).toBeNull();
  });
});

describe('subscription targeting', () => {
  it('only notifies devices subscribed to the variant (empty list means all)', () => {
    const devices = [
      device('ExponentPushToken[all]', []),
      device('ExponentPushToken[silver]', ['silver-16-512']),
      device('ExponentPushToken[midnight]', ['midnight-16-512']),
    ];
    const messages = buildMessages([snapshot()], devices);
    expect(messages.map((m) => m.to)).toEqual(['ExponentPushToken[all]', 'ExponentPushToken[silver]']);
  });
});

describe('dispatch', () => {
  it('chunks sends at EXPO_PUSH_BATCH_SIZE', async () => {
    const devices = tokens(250);
    const kv = new FakeKV({ [KV_KEYS.tokenRegistry]: devices });
    let ticketSeq = 0;
    const http = fakeFetch((url, init) => {
      if (url === EXPO_PUSH_SEND_URL) {
        const batch = JSON.parse(init?.body ?? '[]') as unknown[];
        return jsonResponse({
          data: batch.map(() => ({ status: 'ok', id: `ticket-${ticketSeq++}` })),
        });
      }
      return jsonResponse({ data: {} });
    });

    const summary = await dispatch({ kv, fetchImpl: http.fetchImpl, alerts: [snapshot()], now: NOW });

    const sends = http.callsTo(EXPO_PUSH_SEND_URL);
    expect(sends).toHaveLength(3); // 100 + 100 + 50
    expect((sends[0]?.body as unknown[]).length).toBe(EXPO_PUSH_BATCH_SIZE);
    expect((sends[2]?.body as unknown[]).length).toBe(50);
    expect(summary.messages).toBe(250);
    expect(summary.accepted).toBe(250);
    expect(kv.writes).toBe(0); // nothing to prune
  });

  it('prunes a token whose RECEIPT reports DeviceNotRegistered', async () => {
    const devices = [device('ExponentPushToken[alive]'), device('ExponentPushToken[dead]')];
    const kv = new FakeKV({ [KV_KEYS.tokenRegistry]: devices });
    const http = fakeFetch((url) => {
      if (url === EXPO_PUSH_SEND_URL) {
        return jsonResponse({
          data: [
            { status: 'ok', id: 'ticket-alive' },
            { status: 'ok', id: 'ticket-dead' },
          ],
        });
      }
      return jsonResponse({
        data: {
          'ticket-alive': { status: 'ok' },
          'ticket-dead': {
            status: 'error',
            message: 'The recipient device is not registered.',
            details: { error: 'DeviceNotRegistered' },
          },
        },
      });
    });

    const summary = await dispatch({ kv, fetchImpl: http.fetchImpl, alerts: [snapshot()], now: NOW });

    expect(http.callsTo(EXPO_PUSH_RECEIPT_URL)).toHaveLength(1);
    expect(summary.prunedTokens).toBe(1);
    expect(kv.read<RegisteredDevice[]>(KV_KEYS.tokenRegistry)).toEqual([
      device('ExponentPushToken[alive]'),
    ]);
  });

  it('prunes on an immediate ticket-level DeviceNotRegistered without aborting the batch', async () => {
    const devices = [device('ExponentPushToken[dead]'), device('ExponentPushToken[alive]')];
    const kv = new FakeKV({ [KV_KEYS.tokenRegistry]: devices });
    const http = fakeFetch((url) => {
      if (url === EXPO_PUSH_SEND_URL) {
        return jsonResponse({
          data: [
            {
              status: 'error',
              message: '"ExponentPushToken[dead]" is not a registered push notification recipient',
              details: { error: 'DeviceNotRegistered' },
            },
            { status: 'ok', id: 'ticket-alive' },
          ],
        });
      }
      return jsonResponse({ data: { 'ticket-alive': { status: 'ok' } } });
    });

    const summary = await dispatch({ kv, fetchImpl: http.fetchImpl, alerts: [snapshot()], now: NOW });

    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.prunedTokens).toBe(1);
    expect(kv.read<RegisteredDevice[]>(KV_KEYS.tokenRegistry)?.map((d) => d.token)).toEqual([
      'ExponentPushToken[alive]',
    ]);
  });

  it('keeps going when one chunk fails outright', async () => {
    const devices = tokens(150);
    const kv = new FakeKV({ [KV_KEYS.tokenRegistry]: devices });
    let call = 0;
    const http = fakeFetch((url, init) => {
      if (url === EXPO_PUSH_SEND_URL) {
        call += 1;
        if (call === 1) return errorResponse(502);
        const batch = JSON.parse(init?.body ?? '[]') as unknown[];
        return jsonResponse({ data: batch.map((_, i) => ({ status: 'ok', id: `t${i}` })) });
      }
      return jsonResponse({ data: {} });
    });

    const summary = await dispatch({ kv, fetchImpl: http.fetchImpl, alerts: [snapshot()], now: NOW });

    expect(http.callsTo(EXPO_PUSH_SEND_URL)).toHaveLength(2);
    expect(summary.accepted).toBe(50);
    expect(summary.errors[0]).toContain('502');
  });

  it('sends nothing at all when there are no alerts or no devices', async () => {
    const empty = new FakeKV();
    const http = fakeFetch(() => jsonResponse({ data: [] }));

    const noAlerts = await dispatch({ kv: empty, fetchImpl: http.fetchImpl, alerts: [], now: NOW });
    expect(noAlerts.messages).toBe(0);

    const noDevices = await dispatch({
      kv: empty,
      fetchImpl: http.fetchImpl,
      alerts: [snapshot()],
      now: NOW,
    });
    expect(noDevices.messages).toBe(0);
    expect(http.calls).toHaveLength(0);
    expect(empty.writes).toBe(0);
  });
});
