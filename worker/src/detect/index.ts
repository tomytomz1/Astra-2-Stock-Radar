import { ADAPTER_ORDER } from '@astra/contract';
import type { AdapterName, DetectConfig, DetectResult } from '@astra/contract';
import { heuristicAdapter } from './heuristic';
import { jsonLdAdapter } from './jsonld';
import { shopifyJsAdapter } from './shopify-js';
import { shopifyJsonAdapter } from './shopify-json';
import type { Adapter, AdapterContext, FetchLike } from './types';
import { DEFAULT_TIMEOUT_MS, errorMessage } from './util';

const ADAPTERS: Record<AdapterName, Adapter> = {
  'shopify-js': shopifyJsAdapter,
  'shopify-json': shopifyJsonAdapter,
  jsonld: jsonLdAdapter,
  heuristic: heuristicAdapter,
};

export interface DetectOptions {
  productUrl: string;
  config: DetectConfig;
  fetchImpl: FetchLike;
  now: number;
  timeoutMs?: number;
}

/**
 * Run the adapter chain in order and return the FIRST success.
 *
 * `DetectConfig.preferredAdapter` (written by the probe) is tried first, but the rest of the
 * chain still runs behind it: a preference is a hint, not a commitment, so a theme change that
 * kills the preferred endpoint degrades instead of taking detection down.
 *
 * The chain only returns `{ok: false}` when EVERY adapter failed, i.e. when the store could not
 * be read at all. An adapter that parsed the page and found everything sold out returns
 * `{ok: true}` with `available: false` snapshots. Callers must treat these two cases completely
 * differently (invariant 1).
 */
export async function detect(options: DetectOptions): Promise<DetectResult> {
  const order = resolveOrder(options.config.preferredAdapter);
  const ctx: AdapterContext = {
    productUrl: options.productUrl,
    config: options.config,
    fetchImpl: options.fetchImpl,
    now: options.now,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  const failures: string[] = [];
  for (const name of order) {
    const adapter = ADAPTERS[name];
    let result;
    try {
      result = await adapter.run(ctx);
    } catch (err) {
      // An adapter throwing is a bug, but it must degrade to "this adapter failed" rather than
      // taking down the pass — the next adapter may well work.
      failures.push(`${name}: threw ${errorMessage(err)}`);
      continue;
    }
    if (result.ok) return { ok: true, adapter: name, snapshots: result.snapshots };
    failures.push(`${name}: ${result.reason}`);

    // Stop the chain dead on a 429. Every adapter targets the SAME origin -- `.js`, `.json` and
    // the product page share one rate-limit bucket -- so falling through on a throttle sent three
    // requests where one was already one too many, tripling our rate against the host that just
    // asked for less. That is a retry storm, and it is what put this system into a 429 loop it
    // could not leave: the harder we were throttled, the harder we knocked.
    //
    // Falling through remains right for a 404 (this path is gone, a sibling may work). It is
    // exactly wrong for a 429, which is a property of the host rather than the path.
    if (result.rateLimited === true) {
      return {
        ok: false,
        adapter: null,
        reason: `${failures.join(' | ')} | chain aborted: origin is rate limiting`,
        rateLimited: true,
        retryAfterMs: result.retryAfterMs ?? null,
      };
    }
  }

  return {
    ok: false,
    adapter: null,
    reason: failures.length > 0 ? failures.join(' | ') : 'no adapters were attempted',
  };
}

/** Preferred adapter first, then the canonical order with the preference removed. */
export function resolveOrder(preferred: AdapterName | null): AdapterName[] {
  const rest = ADAPTER_ORDER.filter((name) => name !== preferred);
  return preferred === null ? [...ADAPTER_ORDER] : [preferred, ...rest];
}

export { detectConfig, coerceDetectConfig } from './config';
export type { FetchLike, FetchResponse, AdapterContext, Adapter, AdapterResult } from './types';
