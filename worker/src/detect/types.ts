import type { AdapterName, DetectConfig, StockSnapshot } from '@astra/contract';

/**
 * Structural subset of `fetch` used by every adapter.
 *
 * Deliberately not typed as `typeof fetch`: the worker runtime and the test runner ship
 * different `Response`/`RequestInit` globals, and tests inject a plain object rather than a real
 * `Response`. `globalThis.fetch` satisfies this type.
 */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /**
   * Optional so the plain objects tests inject stay valid. Only `Retry-After` is read, and its
   * absence is already a legitimate answer, so nothing depends on this being present.
   */
  headers?: { get(name: string): string | null } | undefined;
}

/** Everything an adapter needs to do its job. */
export interface AdapterContext {
  /** Canonical product URL (no extension). Adapters append `.js` / `.json` as needed. */
  productUrl: string;
  config: DetectConfig;
  fetchImpl: FetchLike;
  /** Epoch ms stamped onto every snapshot produced by this pass. */
  now: number;
  timeoutMs: number;
}

/**
 * An adapter either parsed at least one variant (success) or it did not (failure).
 *
 * Parsing successfully and finding every variant unavailable is a SUCCESS — conflating it with
 * failure would reintroduce the phantom-restock bug that invariant 1 exists to prevent.
 */
export type AdapterResult =
  | { ok: true; snapshots: StockSnapshot[] }
  | {
      ok: false;
      reason: string;
      /**
       * The ORIGIN throttled us, as opposed to this particular endpoint being wrong or gone.
       * The chain treats the two oppositely: a 404 means try the sibling path, a 429 means stop
       * touching this host entirely.
       */
      rateLimited?: boolean;
      /** Parsed `Retry-After`, in ms. Null when the origin did not say. */
      retryAfterMs?: number | null;
    };

export interface Adapter {
  name: AdapterName;
  run(ctx: AdapterContext): Promise<AdapterResult>;
}
