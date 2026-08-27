import { KV_KEYS } from '@astra/contract';
import type { RegisterBody, RegisteredDevice, VariantId } from '@astra/contract';
import { getJson, putJson, type KVStore } from './kv';

/**
 * Device registry: a single KV key holding a JSON array of `RegisteredDevice`.
 *
 * CONCURRENCY LIMITATION -- read honestly rather than papered over: this is a read-modify-write
 * against KV, which offers no compare-and-swap. Two registrations landing in the same instant
 * can lose one of them, and KV's eventual consistency means a fresh write may not be visible to
 * another colo for a few seconds. That is accepted here because device registration is a
 * low-frequency, user-initiated, retryable action (the app re-registers on every launch, so a
 * lost write self-heals on the next open). It would NOT be acceptable for the stock latch --
 * which is why variant state lives in per-variant keys touched only by the single cron pass.
 * If registration volume ever grows, move this key to a Durable Object.
 */

/** Hard cap so a malicious client cannot grow the registry until the value exceeds KV's limit. */
export const MAX_DEVICES = 2000;

/** Expo tokens look like `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`. */
const EXPO_TOKEN_RE = /^Exp(o|onent)PushToken\[[A-Za-z0-9_.:%+/=-]+\]$/;

export function isValidExpoToken(token: unknown): token is string {
  return typeof token === 'string' && token.length <= 256 && EXPO_TOKEN_RE.test(token);
}

export async function readRegistry(kv: KVStore): Promise<RegisteredDevice[]> {
  const raw = await getJson<unknown>(kv, KV_KEYS.tokenRegistry);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRegisteredDevice);
}

function isRegisteredDevice(value: unknown): value is RegisteredDevice {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isValidExpoToken(record['token']) &&
    Array.isArray(record['variantIds']) &&
    record['variantIds'].every((id) => typeof id === 'string') &&
    (record['platform'] === 'ios' || record['platform'] === 'android') &&
    typeof record['registeredAt'] === 'number'
  );
}

/**
 * Idempotent registration: an existing token has its subscriptions REPLACED (not merged), which
 * is what the app expects when the user edits which variants they want.
 */
export async function registerDevice(
  kv: KVStore,
  body: RegisterBody,
  now: number,
): Promise<RegisteredDevice[]> {
  const devices = await readRegistry(kv);
  const device: RegisteredDevice = {
    token: body.token,
    variantIds: dedupe(body.variantIds),
    platform: body.platform,
    registeredAt: now,
  };

  const next = devices.filter((existing) => existing.token !== device.token);
  next.push(device);

  // Evict oldest registrations first if we somehow exceed the cap.
  const trimmed =
    next.length > MAX_DEVICES
      ? [...next].sort((a, b) => a.registeredAt - b.registeredAt).slice(next.length - MAX_DEVICES)
      : next;

  await putJson(kv, KV_KEYS.tokenRegistry, trimmed);
  return trimmed;
}

/** Returns true when something was actually removed (and therefore written). */
export async function unregisterDevice(kv: KVStore, token: string): Promise<boolean> {
  const devices = await readRegistry(kv);
  const next = devices.filter((device) => device.token !== token);
  if (next.length === devices.length) return false;
  await putJson(kv, KV_KEYS.tokenRegistry, next);
  return true;
}

/**
 * Drop tokens Expo told us are dead (`DeviceNotRegistered`). An unpruned registry rots: every
 * pass keeps paying to push at uninstalled apps and the payload grows without bound.
 */
export async function pruneTokens(kv: KVStore, tokens: Iterable<string>): Promise<number> {
  const doomed = new Set(tokens);
  if (doomed.size === 0) return 0;
  const devices = await readRegistry(kv);
  const next = devices.filter((device) => !doomed.has(device.token));
  const removed = devices.length - next.length;
  if (removed === 0) return 0;
  await putJson(kv, KV_KEYS.tokenRegistry, next);
  return removed;
}

/** An empty `variantIds` means "all variants" (see the contract). */
export function devicesForVariant(
  devices: RegisteredDevice[],
  variantId: VariantId,
): RegisteredDevice[] {
  return devices.filter(
    (device) => device.variantIds.length === 0 || device.variantIds.includes(variantId),
  );
}

function dedupe(ids: VariantId[]): VariantId[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
}
