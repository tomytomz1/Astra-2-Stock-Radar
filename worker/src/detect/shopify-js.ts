import type { StockSnapshot } from '@astra/contract';
import type { Adapter, AdapterContext, AdapterResult } from './types';
import {
  asArray,
  asRecord,
  browserHeaders,
  errorMessage,
  fetchWithTimeout,
  parsePriceToCents,
  rateLimitedFailure,
  readBoolean,
  readNumber,
  readString,
} from './util';

/**
 * `GET {PRODUCT_URL}.js` — Shopify's AJAX product endpoint.
 *
 * First in the chain because it is the only public endpoint that states `available` per variant
 * directly, so nothing has to be inferred. Prices here are ALREADY integer cents (unlike the
 * `.json` endpoint, which returns decimal strings).
 */
export const shopifyJsAdapter: Adapter = {
  name: 'shopify-js',
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const url = `${ctx.productUrl}.js`;
    let payload: unknown;
    try {
      const res = await fetchWithTimeout(
        ctx.fetchImpl,
        url,
        { method: 'GET', headers: browserHeaders('application/json,text/javascript,*/*;q=0.1') },
        ctx.timeoutMs,
      );
      // A 429 is about the host, not this path: sibling endpoints share the bucket.
      const throttled = rateLimitedFailure(res, url);
      if (throttled !== null) return throttled;
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${url}` };
      payload = await res.json();
    } catch (err) {
      return { ok: false, reason: `fetch/parse failed for ${url}: ${errorMessage(err)}` };
    }

    const root = asRecord(payload);
    if (root === null) return { ok: false, reason: 'response was not a JSON object' };

    const variants = asArray(root['variants']);
    if (variants === null) return { ok: false, reason: 'no `variants` array in response' };

    // Some themes surface the shop currency here; most do not. Null is a legitimate answer.
    const currency =
      readString(root['currency']) ??
      readString(root['currency_code']) ??
      readString(root['price_currency']) ??
      null;

    const snapshots: StockSnapshot[] = [];
    for (const entry of variants) {
      const snapshot = parseVariant(entry, currency, ctx.now);
      if (snapshot !== null) snapshots.push(snapshot);
    }

    if (snapshots.length === 0) {
      return { ok: false, reason: 'variants array contained no parsable variants' };
    }
    // NOTE: reaching here with every `available === false` is a SUCCESS. "Sold out" is an
    // answer; only "we could not get an answer" is a failure (invariant 1).
    return { ok: true, snapshots };
  },
};

function parseVariant(entry: unknown, currency: string | null, now: number): StockSnapshot | null {
  const v = asRecord(entry);
  if (v === null) return null;

  const variantId = readString(v['id']);
  if (variantId === null) return null;

  const available = resolveAvailability(v);
  if (available === null) return null;

  const title = readString(v['title']) ?? readString(v['name']) ?? `Variant ${variantId}`;
  // The `.js` endpoint returns cents as an integer already; `parsePriceToCents` would divide
  // that by 100 conceptually, so read it as a number and only fall back to string parsing.
  const rawPrice = v['price'];
  const priceCents =
    readNumber(rawPrice) !== null ? Math.round(readNumber(rawPrice) as number) : parsePriceToCents(rawPrice);

  return {
    variantId,
    title,
    available,
    priceCents,
    currency,
    checkedAt: now,
  };
}

/** `available` is authoritative on this endpoint; the fallbacks only cover odd themes. */
function resolveAvailability(v: Record<string, unknown>): boolean | null {
  const explicit = readBoolean(v['available']);
  if (explicit !== null) return explicit;
  const inventoryQuantity = readNumber(v['inventory_quantity']);
  if (inventoryQuantity !== null) return inventoryQuantity > 0;
  // Cannot tell. Refusing to guess is the point — a guessed `false` is a future phantom alert.
  return null;
}
