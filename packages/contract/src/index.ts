/**
 * Shared contract between the Cloudflare Worker (`worker/`) and the Expo app (`app/`).
 *
 * This file is the coordination point for parallel work: the worker and the app are built
 * independently and only agree on what is declared here. Changing a type in this file is a
 * cross-cutting change — update both consumers in the same commit.
 */

/** The product this deployment watches. Scope is deliberately one product. */
export const PRODUCT_URL =
  'https://global.redmagic.gg/products/redmagic-astra-2-gaming-tablet';

export const PRODUCT_TITLE = 'REDMAGIC Astra 2 Gaming Tablet';

/**
 * Stable identifier for a purchasable configuration, e.g. `astra2-silver-16-512`.
 *
 * Derived from the store's own variant id where one exists (Shopify numeric ids are stable
 * across theme changes); the slug form is only used by the `heuristic` adapter, which has no
 * variant ids to work with. Treated as an opaque string everywhere else.
 */
export type VariantId = string;

/** One observation of one variant at one moment. */
export interface StockSnapshot {
  variantId: VariantId;
  /** Human-readable configuration, e.g. "Silver / 16GB + 512GB". Shown in the notification. */
  title: string;
  /** True only when the variant can actually be added to cart right now. */
  available: boolean;
  /** Minor units (cents) in `currency`. Null when the store does not expose a price. */
  priceCents: number | null;
  currency: string | null;
  /** Epoch milliseconds when this observation was made. */
  checkedAt: number;
}

/**
 * Result of one detection pass.
 *
 * Modelled as a discriminated union rather than throwing, because the difference between
 * "the store says out of stock" and "we could not reach the store" is the single most
 * important distinction in this system. Collapsing them causes phantom restock alerts:
 * a failed fetch recorded as `available: false` produces a spurious false→true edge the
 * moment the store recovers. Callers MUST branch on `ok` and leave state untouched when false.
 */
export type DetectResult =
  | { ok: true; adapter: AdapterName; snapshots: StockSnapshot[] }
  | { ok: false; adapter: AdapterName | null; reason: string };

/** Detection strategies, in the order the chain attempts them. First success wins. */
export const ADAPTER_ORDER = [
  'shopify-js',
  'shopify-json',
  'jsonld',
  'heuristic',
] as const;

export type AdapterName = (typeof ADAPTER_ORDER)[number];

/**
 * Written by `pnpm probe` after fingerprinting the live store, read by the worker at runtime.
 * Lets the detection strategy be resolved without a code change — necessary because the
 * build environment cannot reach the store.
 */
export interface DetectConfig {
  /** Adapter confirmed working by the probe. Null means "try the whole chain in order". */
  preferredAdapter: AdapterName | null;
  /** Only used by the `heuristic` adapter: regexes marking a variant as sold out. */
  soldOutPatterns: string[];
  /** Only used by the `heuristic` adapter: regexes marking a variant as purchasable. */
  inStockPatterns: string[];
  /** When the probe last confirmed this config against the live store. ISO 8601. */
  probedAt: string | null;
}

// ---------------------------------------------------------------------------
// Worker HTTP API — consumed by the app
// ---------------------------------------------------------------------------

/** `POST /register` — idempotent; re-registering the same token replaces its subscriptions. */
export interface RegisterBody {
  /** Expo push token, e.g. `ExponentPushToken[xxxxxxxx]`. */
  token: string;
  /** Variants this device wants alerts for. Empty array means "all variants". */
  variantIds: VariantId[];
  platform: 'ios' | 'android';
}

/** `POST /unregister` */
export interface UnregisterBody {
  token: string;
}

/** `GET /status` — drives the app's status screen. */
export interface StatusResponse {
  snapshots: StockSnapshot[];
  /** Epoch ms of the last successful detection pass, or null if none has succeeded yet. */
  lastSuccessAt: number | null;
  /** Consecutive failed detection passes. Non-zero means the detector may be broken. */
  consecutiveFailures: number;
  adapter: AdapterName | null;
  /**
   * Devices currently registered for alerts. Zero means a restock would be detected correctly
   * and then delivered to nobody — indistinguishable from a healthy system in every other field
   * here, which is exactly why it is reported.
   */
  registeredDevices: number;
}

/** Shape of the `data` payload attached to every restock push. */
export interface RestockPushData {
  kind: 'restock';
  variantId: VariantId;
  url: string;
  /**
   * Set only on an alert triggered by `KV_KEYS.forceAlert`. The notification itself is otherwise
   * byte-identical to a real one on purpose — a test alert that looks different does not test
   * the thing you care about. Nothing in the app reads this today; it exists so a future
   * consumer can tell them apart without changing what the user sees.
   */
  test?: boolean;
}

/**
 * Sent when the detector itself breaks or recovers — the store became unreadable, so the
 * system has gone blind and silence can no longer be trusted to mean "not in stock".
 *
 * Deliberately a separate `kind` from `restock`: these must never deep-link to the product
 * page. A "tap to buy" affordance on an alert that means "I cannot see the store" would be
 * actively misleading.
 */
export interface DetectorPushData {
  kind: 'detector-down' | 'detector-recovered';
  consecutiveFailures: number;
  /** Last failure reason, truncated. Null on recovery. */
  reason: string | null;
}

/**
 * Periodic proof of life.
 *
 * Push tokens do not live forever — an OS update, a reinstall, or ordinary APNs housekeeping can
 * invalidate one. The Worker prunes it correctly on a `DeviceNotRegistered` receipt, and the
 * result is an empty registry with everything else looking perfectly healthy: the cron fires,
 * detection succeeds, `/status` reports zero failures, and there is nobody left to notify.
 *
 * The app re-registers on foreground, so opening it heals this — but the whole premise is that
 * you never open it. Without a heartbeat the system can sit silently dead for months and the
 * first sign would be a restock that never reached you.
 */
export interface HeartbeatPushData {
  kind: 'heartbeat';
  /** Variants being watched at the time of the ping. Evidence, not reassurance. */
  variantCount: number;
  /** Epoch ms of the last successful store read. */
  lastSuccessAt: number;
}

/** Every push payload this system can send. Consumers should switch on `kind`. */
export type PushData = RestockPushData | DetectorPushData | HeartbeatPushData;

// ---------------------------------------------------------------------------
// Tunables — see plan file for the reasoning behind each
// ---------------------------------------------------------------------------

/**
 * Per-variant silence window after an alert fires, in ms. Prevents a flapping endpoint from
 * spamming. Does not delay the first alert — the latch fires on the first observed `true`.
 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Expo's per-request message cap. Sends must be chunked to this size. */
export const EXPO_PUSH_BATCH_SIZE = 100;

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/**
 * Android notification channels. These MUST live in the contract: the app creates the channel
 * and the worker names it in the outgoing push, and if the two strings disagree Android
 * silently delivers on a fallback channel instead of erroring — the high-priority sound and
 * importance configured on the real channel are just quietly not applied.
 *
 * Two channels, not one, so a detector-down page can be muted independently of a restock
 * alert. Muting the thing you actually care about to silence the plumbing would be the wrong
 * trade to force on anyone.
 */
export const ANDROID_CHANNEL_RESTOCK = 'restock-alerts';
export const ANDROID_CHANNEL_DETECTOR = 'detector-alerts';

/**
 * Currency assumed when the storefront does not state one.
 *
 * The live store's `.js` endpoint returns prices with no currency field at all, so without this
 * a restock alert reads "699.00 — tap to open…". A bare number in the one notification that has
 * to be unambiguous at 3am is worse than a possibly-wrong symbol, and this store prices in USD.
 */
export const FALLBACK_CURRENCY = 'USD';

/**
 * How often to send proof of life, in ms.
 *
 * Weekly is the compromise: frequent enough that a silently dead registry surfaces in days
 * rather than months, rare enough not to become noise you learn to swipe away. If the ping stops
 * arriving, something is broken — that is the whole signal.
 */
export const HEARTBEAT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Consecutive detection failures before the detector itself is reported as broken. */
export const FAILURE_ALERT_THRESHOLD = 15;

/**
 * How long to stay quiet after paging about a broken detector, in ms.
 *
 * At a 1-minute cron, `FAILURE_ALERT_THRESHOLD` means roughly 15 minutes of sustained failure
 * before the first page — long enough that a transient blip or one bad deploy on the store's
 * side does not wake anyone. After that, a multi-day outage re-pages on this interval rather
 * than every pass.
 */
export const DETECTOR_PAGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** KV key helpers. Centralised so the worker and the simulate-restock script cannot drift. */
export const KV_KEYS = {
  variantState: (id: VariantId) => `state:variant:${id}`,
  tokenRegistry: 'registry:tokens',
  health: 'state:health',
  /**
   * One-shot test trigger. Holds a `VariantId`; the next successful cron pass sends a real
   * restock alert for it and deletes the key.
   *
   * It exists because nothing else can demonstrate delivery while the product is sold out. The
   * latch only fires on a genuine false->true edge from the live store, which is correct for the
   * product and useless for answering "has a notification ever reached the phone".
   *
   * Deliberately a KV key rather than an HTTP endpoint: setting it requires Cloudflare account
   * auth via wrangler, where a debug route would let anyone holding the worker URL ring the
   * device.
   */
  forceAlert: 'debug:force-alert',
} as const;

/** Persisted per-variant latch state. Written only when it changes (free-tier write budget). */
export interface VariantState {
  available: boolean;
  /** Epoch ms of the last alert sent for this variant, or null if never alerted. */
  lastAlertedAt: number | null;
  lastChangedAt: number;
}

/** Persisted detector health, used by `/status` and the broken-detector alert. */
export interface HealthState {
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastAdapter: AdapterName | null;
  lastReason: string | null;
  /**
   * Epoch ms of the last liveness heartbeat, or null if none has been sent.
   *
   * Lives on the health record rather than its own KV key because `recordSuccess` already reads
   * this record on every pass — so the heartbeat costs zero additional reads and one write a
   * week. Every code path that writes health MUST carry this value forward; dropping it would
   * make the heartbeat re-fire on the next pass.
   */
  lastHeartbeatAt: number | null;
  /**
   * Epoch ms of the last detector-down page, or null if the current outage has not been paged
   * (or there is no outage). Doubles as the "an outage is open" flag: non-null on a successful
   * pass means a recovery notice is owed. Read defensively with `?? null` — records written
   * before this field existed will not have it.
   */
  lastPagedAt: number | null;
}

/** One registered device. */
export interface RegisteredDevice {
  token: string;
  variantIds: VariantId[];
  platform: 'ios' | 'android';
  registeredAt: number;
}
