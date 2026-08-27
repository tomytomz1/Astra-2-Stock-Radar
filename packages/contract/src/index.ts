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
}

/** Shape of the `data` payload attached to every restock push. */
export interface RestockPushData {
  kind: 'restock';
  variantId: VariantId;
  url: string;
}

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

/** Consecutive detection failures before the detector itself is reported as broken. */
export const FAILURE_ALERT_THRESHOLD = 15;

/** KV key helpers. Centralised so the worker and the simulate-restock script cannot drift. */
export const KV_KEYS = {
  variantState: (id: VariantId) => `state:variant:${id}`,
  tokenRegistry: 'registry:tokens',
  health: 'state:health',
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
}

/** One registered device. */
export interface RegisteredDevice {
  token: string;
  variantIds: VariantId[];
  platform: 'ios' | 'android';
  registeredAt: number;
}
