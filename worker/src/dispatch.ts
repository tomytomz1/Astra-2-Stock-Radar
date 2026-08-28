import {
  FALLBACK_CURRENCY,
  ANDROID_CHANNEL_DETECTOR,
  ANDROID_CHANNEL_RESTOCK,
  EXPO_PUSH_BATCH_SIZE,
  EXPO_PUSH_RECEIPT_URL,
  EXPO_PUSH_SEND_URL,
  PRODUCT_URL,
} from '@astra/contract';
import type {
  DetectorPushData,
  HeartbeatPushData,
  PushData,
  RegisteredDevice,
  RestockPushData,
  StockSnapshot,
} from '@astra/contract';
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

// Android notification channel ids come from `@astra/contract` -- never from a local literal.
// This file used to declare `ANDROID_CHANNEL_ID = 'restock'` while the app created the channel as
// `'restock-alerts'`. Android 8+ does not error on an unknown channel id: it quietly delivers on a
// fallback channel, so the MAX importance, sound and vibration configured on the real channel were
// simply never applied -- invisible until the one push that matters arrives silent. Both ids now
// live in the contract so the two sides cannot drift again.

/** Longest failure reason we are willing to put in a notification body. */
export const DETECTOR_REASON_MAX_CHARS = 140;

/**
 * How long Expo may hold a detector page, in seconds.
 *
 * Longer than a restock's 900s: a restock alert is worthless once the drop is over, but "the
 * watcher is blind" stays true (and worth knowing) until it is fixed.
 */
const DETECTOR_TTL_SECONDS = 3600;

/** Expo accepts up to 1000 receipt ids per request. */
const RECEIPT_BATCH_SIZE = 1000;

/** Expo's error code for a token whose app has been uninstalled or reinstalled. */
const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/**
 * One outgoing Expo push. Parameterised by payload so a restock message and a detector page
 * cannot be confused for one another at a call site, while the send/receipt machinery below can
 * still work over `ExpoMessage<PushData>` uniformly.
 */
export interface ExpoMessage<D extends PushData = PushData> {
  to: string;
  title: string;
  body: string;
  data: D;
  /** iOS only in practice: on Android the channel owns the sound. */
  sound: 'default' | null;
  priority: 'high' | 'normal';
  channelId: typeof ANDROID_CHANNEL_RESTOCK | typeof ANDROID_CHANNEL_DETECTOR;
  ttl: number;
  /**
   * iOS 15+ only. Without it a notification defaults to `active`, which Focus modes suppress —
   * including Sleep Focus, i.e. exactly the 3am drop this system exists for. `time-sensitive`
   * breaks through, lights the screen, and is Apple's documented category for information the
   * user has explicitly asked to be alerted about.
   *
   * Requires the `com.apple.developer.usernotifications.time-sensitive` entitlement, declared in
   * app.config.ts. Without that entitlement iOS silently downgrades it to `active`, so shipping
   * this before a rebuild is a no-op rather than a regression.
   */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
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

export interface DispatchOptions extends Transport {
  alerts: StockSnapshot[];
  now: number;
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
): ExpoMessage<RestockPushData>[] {
  const messages: ExpoMessage<RestockPushData>[] = [];
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
        interruptionLevel: 'time-sensitive',
        channelId: ANDROID_CHANNEL_RESTOCK,
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
  // The live store's `.js` endpoint states no currency, so fall back rather than render a bare
  // number: "699.00" in a restock alert is ambiguous exactly when it matters most.
  const resolved = currency ?? FALLBACK_CURRENCY;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: resolved }).format(amount);
  } catch {
    // Unknown or invalid currency code: degrade to the plain form rather than throwing inside a
    // cron pass, where an exception would cost the whole detection cycle.
    return `${amount.toFixed(2)} ${resolved}`;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Everything the shared send path needs, independent of what is being sent. */
interface Transport {
  kv: KVStore;
  fetchImpl: FetchLike;
  /** Optional Expo access token, when the project has "enhanced push security" enabled. */
  accessToken?: string | undefined;
}

export interface DetectorDispatchOptions extends Transport {
  now: number;
  kind: DetectorPushData['kind'];
  /** Consecutive failed passes at the moment of the page. */
  consecutiveFailures: number;
  /** Last failure reason; null on recovery. Truncated before it reaches the payload. */
  reason: string | null;
}

export interface HeartbeatDispatchOptions extends Transport {
  now: number;
  /** Variants being watched, for the evidence in the body. */
  variantCount: number;
  /** Epoch ms of the last successful store read. */
  lastSuccessAt: number;
}

/**
 * Build one heartbeat per registered device.
 *
 * Rides the DETECTOR channel at normal priority and is never Time Sensitive. A weekly "still
 * working" ping on the restock channel would train the reader to swipe away the one sound that
 * matters; the two-channel split exists precisely so this can be muted on its own.
 */
export function buildHeartbeatMessages(
  devices: RegisteredDevice[],
  variantCount: number,
  lastSuccessAt: number,
  now: number,
): ExpoMessage<HeartbeatPushData>[] {
  const data: HeartbeatPushData = { kind: 'heartbeat', variantCount, lastSuccessAt };
  const body = heartbeatBody(variantCount, lastSuccessAt, now);
  return devices.map((device) => ({
    to: device.token,
    title: `${SHORT_PRODUCT_NAME} watcher is running`,
    body,
    data,
    sound: null,
    priority: 'normal',
    channelId: ANDROID_CHANNEL_DETECTOR,
    // Worthless once the next one is due; never let Expo hold it that long.
    ttl: 24 * 3600,
  }));
}

/**
 * Evidence, not reassurance. "Everything is fine" would be equally true of a system that had
 * stopped reading the store an hour ago; a variant count and a real timestamp are checkable.
 */
export function heartbeatBody(variantCount: number, lastSuccessAt: number, now: number): string {
  const ageSeconds = Math.max(0, Math.round((now - lastSuccessAt) / 1000));
  const age =
    ageSeconds < 90 ? `${ageSeconds}s ago` : `${Math.round(ageSeconds / 60)} min ago`;
  const variants = `${variantCount} variant${variantCount === 1 ? '' : 's'}`;
  return `Watching ${variants} · store read ${age}. You will be alerted on restock.`;
}

/** Send one liveness ping to every registered device. Silent when nobody is registered. */
export async function dispatchHeartbeat(
  options: HeartbeatDispatchOptions,
): Promise<DispatchSummary> {
  const devices = await readRegistry(options.kv);
  if (devices.length === 0) return emptySummary();
  const messages = buildHeartbeatMessages(
    devices,
    options.variantCount,
    options.lastSuccessAt,
    options.now,
  );
  return sendMessages(options, messages);
}

function emptySummary(): DispatchSummary {
  return { messages: 0, accepted: 0, rejected: 0, prunedTokens: 0, errors: [] };
}

/**
 * Build one detector page per registered device.
 *
 * Tone is the point here. A detector page must be distinguishable from a restock at a glance --
 * it uses its own Android channel, `priority: 'normal'` and no "tap to buy" affordance, because
 * being told the plumbing broke should not feel identical to "the tablet is buyable right now".
 */
export function buildDetectorMessages(
  devices: RegisteredDevice[],
  kind: DetectorPushData['kind'],
  consecutiveFailures: number,
  reason: string | null,
): ExpoMessage<DetectorPushData>[] {
  const down = kind === 'detector-down';
  const data: DetectorPushData = {
    kind,
    consecutiveFailures,
    // A recovery carries no reason (contract): the failure it refers to is over.
    reason: down ? truncateReason(reason) : null,
  };
  const title = down
    ? `${SHORT_PRODUCT_NAME} watcher is DOWN`
    : `${SHORT_PRODUCT_NAME} watcher is back`;
  const body = down ? detectorDownBody(consecutiveFailures, data.reason) : DETECTOR_RECOVERED_BODY;

  return devices.map((device) => ({
    to: device.token,
    title,
    body,
    data,
    sound: 'default',
    // Not `high`: this is important, not time-critical. The tablet being buyable is the only
    // thing in this system that earns an interruption.
    priority: 'normal',
    channelId: ANDROID_CHANNEL_DETECTOR,
    ttl: DETECTOR_TTL_SECONDS,
  }));
}

/**
 * The one thing this notification must convey: silence has stopped being evidence. Until this
 * is fixed, "no alert" means "no idea", not "not in stock yet".
 */
export function detectorDownBody(consecutiveFailures: number, reason: string | null): string {
  const checks = `${consecutiveFailures} consecutive check${consecutiveFailures === 1 ? '' : 's'}`;
  const lead = `Could not read the store for ${checks} — silence no longer means "not in stock".`;
  return reason === null ? `${lead} Reason unknown.` : `${lead} Last error: ${reason}`;
}

export const DETECTOR_RECOVERED_BODY =
  'Reading the store again. Restock alerts are live — silence means sold out once more.';

function truncateReason(reason: string | null): string | null {
  if (reason === null) return null;
  const trimmed = reason.trim();
  if (trimmed === '') return null;
  return trimmed.length <= DETECTOR_REASON_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, DETECTOR_REASON_MAX_CHARS - 1)}…`;
}

/**
 * Send every alert, then reconcile tickets and receipts and prune dead tokens.
 *
 * Failure handling: one bad token, one rejected chunk or one unparsable response must not abort
 * the rest. Every problem is collected into `errors` and the pass continues.
 */
export async function dispatch(options: DispatchOptions): Promise<DispatchSummary> {
  if (options.alerts.length === 0) return emptySummary();
  const devices = await readRegistry(options.kv);
  const messages = buildMessages(options.alerts, devices, options.productUrl ?? PRODUCT_URL);
  return sendMessages(options, messages);
}

/**
 * Page every registered device that the detector itself is broken (or has recovered).
 *
 * Deliberately NOT filtered by `variantIds`: a subscription says which variant you want to buy,
 * and "I can no longer see the store" is not about a variant -- it invalidates the meaning of
 * silence for every subscription at once. Filtering here would leave a device that only watches
 * one config believing no news is good news.
 */
export async function dispatchDetectorPage(
  options: DetectorDispatchOptions,
): Promise<DispatchSummary> {
  const devices = await readRegistry(options.kv);
  const messages = buildDetectorMessages(
    devices,
    options.kind,
    options.consecutiveFailures,
    options.reason,
  );
  return sendMessages(options, messages);
}

/**
 * Shared send path for every kind of push: chunk to `EXPO_PUSH_BATCH_SIZE`, read receipts, prune
 * `DeviceNotRegistered` tokens. Restock alerts and detector pages differ only in what they say.
 */
async function sendMessages(
  options: Transport,
  messages: ExpoMessage[],
): Promise<DispatchSummary> {
  const summary = emptySummary();
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
  options: Transport,
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
