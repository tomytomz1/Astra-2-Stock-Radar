import {
  EXPO_PUSH_BATCH_SIZE,
  EXPO_PUSH_RECEIPT_URL,
  EXPO_PUSH_SEND_URL,
  PRODUCT_URL,
} from '@astra/contract';
import type { RegisteredDevice, RestockPushData, StockSnapshot } from '@astra/contract';
import type { FetchLike } from './detect/types';
import { asArray, asRecord, errorMessage, readString } from './detect/util';
import type { KVStore } from './kv';
import { devicesForVariant, pruneTokens, readRegistry } from './registry';

/**
 * Display-only abbreviation of `PRODUCT_TITLE`. Not a contract value: iOS truncates notification
 * titles around 40 characters and "REDMAGIC Astra 2 Gaming Tablet -- Silver / 16GB + 512GB is IN
 * STOCK" would be cut before the part that matters.
 */
const SHORT_PRODUCT_NAME = 'Astra 2';

/**
 * Android notification channel id.
 *
 * MUST match the channel the app registers with `setNotificationChannelAsync`. Android 8+ drops
 * (or downgrades) a notification whose channel does not exist on the device, so a mismatch here
 * is a silent no-show rather than a visible error. The channel id is not part of
 * `@astra/contract`, so it can only be kept in sync by agreement -- if the app changes its
 * channel id, change this string in the same commit.
 */
export const ANDROID_CHANNEL_ID = 'restock';

/** Expo accepts up to 1000 receipt ids per request. */
const RECEIPT_BATCH_SIZE = 1000;

/** Expo's error code for a token whose app has been uninstalled or reinstalled. */
const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: RestockPushData;
  sound: 'default';
  priority: 'high';
  /** Android notification channel; see `ANDROID_CHANNEL_ID`. */
  channelId: typeof ANDROID_CHANNEL_ID;
  ttl: number;
}

export interface DispatchSummary {
  messages: number;
  /** Tickets Expo accepted. */
  accepted: number;
  /** Tickets Expo rejected immediately. */
  rejected: number;
  prunedTokens: number;
  errors: string[];
}

export interface DispatchOptions {
  kv: KVStore;
  fetchImpl: FetchLike;
  alerts: StockSnapshot[];
  now: number;
  /** Optional Expo access token, when the project has "enhanced push security" enabled. */
  accessToken?: string | undefined;
  productUrl?: string;
}

/**
 * Build one message per (alert, subscribed device) pair.
 *
 * A device with an empty `variantIds` is subscribed to everything (contract semantics).
 */
export function buildMessages(
  alerts: StockSnapshot[],
  devices: RegisteredDevice[],
  productUrl: string = PRODUCT_URL,
): ExpoMessage[] {
  const messages: ExpoMessage[] = [];
  for (const alert of alerts) {
    const targets = devicesForVariant(devices, alert.variantId);
    const data: RestockPushData = {
      kind: 'restock',
      variantId: alert.variantId,
      url: productUrl,
    };
    for (const device of targets) {
      messages.push({
        to: device.token,
        title: buildTitle(alert),
        body: buildBody(alert),
        data,
        sound: 'default',
        priority: 'high',
        channelId: ANDROID_CHANNEL_ID,
        // A restock alert is worthless an hour late; do not let Expo hold it longer.
        ttl: 900,
      });
    }
  }
  return messages;
}

/** e.g. `Astra 2 -- Silver / 16GB + 512GB is IN STOCK` */
export function buildTitle(alert: StockSnapshot): string {
  return `${SHORT_PRODUCT_NAME} — ${alert.title} is IN STOCK`;
}

export function buildBody(alert: StockSnapshot): string {
  const price = formatPrice(alert.priceCents, alert.currency);
  return price === null
    ? 'Tap to open the product page before it sells out.'
    : `${price} — tap to open the product page before it sells out.`;
}

export function formatPrice(priceCents: number | null, currency: string | null): string | null {
  if (priceCents === null) return null;
  const amount = priceCents / 100;
  if (currency !== null) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
    } catch {
      // Unknown/invalid currency code: fall through to the plain form rather than throwing
      // inside a cron pass.
      return `${amount.toFixed(2)} ${currency}`;
    }
  }
  return amount.toFixed(2);
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Send every alert, then reconcile tickets and receipts and prune dead tokens.
 *
 * Failure handling: one bad token, one rejected chunk or one unparsable response must not abort
 * the rest. Every problem is collected into `errors` and the pass continues.
 */
export async function dispatch(options: DispatchOptions): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    messages: 0,
    accepted: 0,
    rejected: 0,
    prunedTokens: 0,
    errors: [],
  };
  if (options.alerts.length === 0) return summary;

  const devices = await readRegistry(options.kv);
  const messages = buildMessages(options.alerts, devices, options.productUrl ?? PRODUCT_URL);
  summary.messages = messages.length;
  if (messages.length === 0) return summary;

  const doomedTokens = new Set<string>();
  /** ticket id -> token, so a receipt error can be traced back to the device that owns it. */
  const ticketToToken = new Map<string, string>();

  for (const batch of chunk(messages, EXPO_PUSH_BATCH_SIZE)) {
    let payload: unknown;
    try {
      const res = await options.fetchImpl(EXPO_PUSH_SEND_URL, {
        method: 'POST',
        headers: expoHeaders(options.accessToken),
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        summary.errors.push(`push send HTTP ${res.status}`);
        continue;
      }
      payload = await res.json();
    } catch (err) {
      summary.errors.push(`push send failed: ${errorMessage(err)}`);
      continue;
    }

    const tickets = asArray(asRecord(payload)?.['data']) ?? [];
    // Expo returns tickets positionally, so index i belongs to batch[i].
    tickets.forEach((entry, index) => {
      const ticket = asRecord(entry);
      const message = batch[index];
      if (ticket === null || message === undefined) return;
      const status = readString(ticket['status']);
      if (status === 'ok') {
        summary.accepted += 1;
        const id = readString(ticket['id']);
        if (id !== null) ticketToToken.set(id, message.to);
        return;
      }
      summary.rejected += 1;
      const detail = readString(asRecord(ticket['details'])?.['error']);
      const reason = readString(ticket['message']) ?? detail ?? 'unknown error';
      summary.errors.push(`ticket rejected (${reason})`);
      // Immediate ticket-level DeviceNotRegistered is just as authoritative as a receipt one.
      if (detail === DEVICE_NOT_REGISTERED) doomedTokens.add(message.to);
    });
  }

  await collectReceipts(options, ticketToToken, doomedTokens, summary);

  if (doomedTokens.size > 0) {
    try {
      summary.prunedTokens = await pruneTokens(options.kv, doomedTokens);
    } catch (err) {
      summary.errors.push(`prune failed: ${errorMessage(err)}`);
    }
  }

  return summary;
}

/**
 * Query receipts for the tickets Expo accepted.
 *
 * Expo's guidance is to wait ~15 minutes before reading receipts, which a 1-minute cron cannot
 * do without persisting ticket ids across passes. We read immediately and act on whatever is
 * already resolved: a receipt that is not ready yet simply is not in the response, and the
 * dominant `DeviceNotRegistered` case is usually reported at ticket level anyway. The cost of
 * missing one is one wasted push on the next restock, not a correctness problem.
 */
async function collectReceipts(
  options: DispatchOptions,
  ticketToToken: Map<string, string>,
  doomedTokens: Set<string>,
  summary: DispatchSummary,
): Promise<void> {
  const ids = [...ticketToToken.keys()];
  if (ids.length === 0) return;

  for (const batch of chunk(ids, RECEIPT_BATCH_SIZE)) {
    let payload: unknown;
    try {
      const res = await options.fetchImpl(EXPO_PUSH_RECEIPT_URL, {
        method: 'POST',
        headers: expoHeaders(options.accessToken),
        body: JSON.stringify({ ids: batch }),
      });
      if (!res.ok) {
        summary.errors.push(`receipt fetch HTTP ${res.status}`);
        continue;
      }
      payload = await res.json();
    } catch (err) {
      summary.errors.push(`receipt fetch failed: ${errorMessage(err)}`);
      continue;
    }

    const receipts = asRecord(asRecord(payload)?.['data']);
    if (receipts === null) continue;
    for (const [id, value] of Object.entries(receipts)) {
      const receipt = asRecord(value);
      if (receipt === null) continue;
      if (readString(receipt['status']) !== 'error') continue;
      const detail = readString(asRecord(receipt['details'])?.['error']);
      summary.errors.push(`receipt error (${detail ?? 'unknown'})`);
      if (detail !== DEVICE_NOT_REGISTERED) continue;
      const token = ticketToToken.get(id);
      if (token !== undefined) doomedTokens.add(token);
    }
  }
}

function expoHeaders(accessToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
  };
  if (accessToken !== undefined && accessToken !== '') {
    headers['authorization'] = `Bearer ${accessToken}`;
  }
  return headers;
}
