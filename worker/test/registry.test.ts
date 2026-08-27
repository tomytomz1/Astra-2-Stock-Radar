import { describe, expect, it } from 'vitest';
import { KV_KEYS } from '@astra/contract';
import type { RegisteredDevice, StatusResponse } from '@astra/contract';
import {
  devicesForVariant,
  isValidExpoToken,
  pruneTokens,
  readRegistry,
  registerDevice,
  unregisterDevice,
} from '../src/registry';
import worker, { type Env } from '../src/index';
import { FakeKV } from './helpers';

const NOW = 1_772_000_000_000;
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

function env(kv: FakeKV): Env {
  return { STOCK_KV: kv as unknown as KVNamespace };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('token validation', () => {
  it('accepts both Expo token spellings and rejects anything else', () => {
    expect(isValidExpoToken(TOKEN)).toBe(true);
    expect(isValidExpoToken('ExpoPushToken[abc-123_45]')).toBe(true);
    expect(isValidExpoToken('ExponentPushToken[]')).toBe(false);
    expect(isValidExpoToken('fcm-token-abc')).toBe(false);
    expect(isValidExpoToken('')).toBe(false);
    expect(isValidExpoToken(42)).toBe(false);
    expect(isValidExpoToken(`ExponentPushToken[${'a'.repeat(400)}]`)).toBe(false);
  });
});

describe('registry', () => {
  it('is idempotent: re-registering replaces the subscription list', async () => {
    const kv = new FakeKV();
    await registerDevice(kv, { token: TOKEN, variantIds: ['a', 'b'], platform: 'ios' }, NOW);
    await registerDevice(kv, { token: TOKEN, variantIds: ['c'], platform: 'android' }, NOW + 1000);

    const devices = await readRegistry(kv);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.variantIds).toEqual(['c']);
    expect(devices[0]?.platform).toBe('android');
  });

  it('drops duplicate variant ids', async () => {
    const kv = new FakeKV();
    const devices = await registerDevice(
      kv,
      { token: TOKEN, variantIds: ['a', 'a', 'b'], platform: 'ios' },
      NOW,
    );
    expect(devices[0]?.variantIds).toEqual(['a', 'b']);
  });

  it('does not write when unregistering an unknown token', async () => {
    const kv = new FakeKV();
    await registerDevice(kv, { token: TOKEN, variantIds: [], platform: 'ios' }, NOW);
    kv.resetCounters();

    expect(await unregisterDevice(kv, 'ExponentPushToken[other]')).toBe(false);
    expect(kv.writes).toBe(0);
    expect(await unregisterDevice(kv, TOKEN)).toBe(true);
    expect(kv.writes).toBe(1);
  });

  it('ignores corrupt registry entries instead of throwing', async () => {
    const kv = new FakeKV({
      [KV_KEYS.tokenRegistry]: [
        { token: TOKEN, variantIds: [], platform: 'ios', registeredAt: NOW },
        { token: 'garbage', variantIds: [], platform: 'ios', registeredAt: NOW },
        'nonsense',
      ],
    });
    const devices = await readRegistry(kv);
    expect(devices.map((d) => d.token)).toEqual([TOKEN]);
  });

  it('prunes only the requested tokens and writes once', async () => {
    const seed: RegisteredDevice[] = [
      { token: 'ExponentPushToken[a]', variantIds: [], platform: 'ios', registeredAt: NOW },
      { token: 'ExponentPushToken[b]', variantIds: [], platform: 'android', registeredAt: NOW },
    ];
    const kv = new FakeKV({ [KV_KEYS.tokenRegistry]: seed });
    expect(await pruneTokens(kv, ['ExponentPushToken[b]', 'ExponentPushToken[missing]'])).toBe(1);
    expect(kv.writes).toBe(1);
    expect((await readRegistry(kv)).map((d) => d.token)).toEqual(['ExponentPushToken[a]']);

    kv.resetCounters();
    expect(await pruneTokens(kv, [])).toBe(0);
    expect(kv.writes).toBe(0);
  });

  it('treats an empty variantIds list as "all variants"', () => {
    const all: RegisteredDevice = {
      token: 'ExponentPushToken[all]',
      variantIds: [],
      platform: 'ios',
      registeredAt: NOW,
    };
    const one: RegisteredDevice = { ...all, token: 'ExponentPushToken[one]', variantIds: ['x'] };
    expect(devicesForVariant([all, one], 'x').map((d) => d.token)).toEqual([
      'ExponentPushToken[all]',
      'ExponentPushToken[one]',
    ]);
    expect(devicesForVariant([all, one], 'y').map((d) => d.token)).toEqual(['ExponentPushToken[all]']);
  });
});

describe('HTTP API', () => {
  it('registers a valid device', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(
      post('/register', { token: TOKEN, variantIds: [], platform: 'ios' }),
      env(kv),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await readRegistry(kv)).toHaveLength(1);
  });

  it('rejects a token that is not an Expo push token', async () => {
    const kv = new FakeKV();
    const res = await worker.fetch(
      post('/register', { token: 'fcm:abc', variantIds: [], platform: 'ios' }),
      env(kv),
    );
    expect(res.status).toBe(400);
    expect(kv.writes).toBe(0);
  });

  it('rejects a bad platform and non-string variantIds', async () => {
    const kv = new FakeKV();
    const badPlatform = await worker.fetch(
      post('/register', { token: TOKEN, variantIds: [], platform: 'web' }),
      env(kv),
    );
    const badVariants = await worker.fetch(
      post('/register', { token: TOKEN, variantIds: [1, 2], platform: 'ios' }),
      env(kv),
    );
    expect(badPlatform.status).toBe(400);
    expect(badVariants.status).toBe(400);
  });

  it('unregisters', async () => {
    const kv = new FakeKV();
    await registerDevice(kv, { token: TOKEN, variantIds: [], platform: 'ios' }, NOW);
    const res = await worker.fetch(post('/unregister', { token: TOKEN }), env(kv));
    expect(res.status).toBe(200);
    expect(await readRegistry(kv)).toHaveLength(0);
  });

  it('serves /status from KV', async () => {
    const kv = new FakeKV({
      'state:health': {
        lastSuccessAt: NOW,
        consecutiveFailures: 2,
        lastAdapter: 'shopify-js',
        lastReason: 'HTTP 503',
      },
      'cache:snapshots': {
        snapshots: [
          {
            variantId: 'silver',
            title: 'Silver',
            available: false,
            priceCents: 89900,
            currency: 'USD',
            checkedAt: NOW,
          },
        ],
        updatedAt: NOW,
      },
    });
    const res = await worker.fetch(new Request('https://worker.example/status'), env(kv));
    const body = (await res.json()) as StatusResponse;
    expect(res.status).toBe(200);
    expect(body.adapter).toBe('shopify-js');
    expect(body.consecutiveFailures).toBe(2);
    expect(body.snapshots).toHaveLength(1);
  });

  it('answers CORS preflight and 404s anything else', async () => {
    const kv = new FakeKV();
    const preflight = await worker.fetch(
      new Request('https://worker.example/register', { method: 'OPTIONS' }),
      env(kv),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

    const missing = await worker.fetch(new Request('https://worker.example/nope'), env(kv));
    expect(missing.status).toBe(404);
  });
});
