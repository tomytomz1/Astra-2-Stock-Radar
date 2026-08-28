import type { SourceId, StockSnapshot } from '@astra/contract';
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
 * `GET {PRODUCT_URL}.json` — Shopify's REST-ish product endpoint.
 *
 * Two traps relative to `.js`:
 *   1. `price` is a DECIMAL STRING ("899.00"), not cents. Converted with exact integer string
 *      arithmetic — see `parsePriceToCents`.
 *   2. `available` is frequently ABSENT on the public storefront endpoint. Availability is then
 *      derived from Shopify's inventory semantics, and when nothing derivable is present the
 *      variant is dropped rather than assumed sold out.
 */
export const shopifyJsonAdapter: Adapter = {
  name: 'shopify-json',
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const url = `${ctx.productUrl}.json`;
    let payload: unknown;
    try {
      const res = await fetchWithTimeout(
        ctx.fetchImpl,
        url,
        { method: 'GET', headers: browserHeaders('application/json,*/*;q=0.1') },
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

    // Accept both `{product: {...}}` and a bare product object.
    const product = asRecord(root['product']) ?? root;
    const variants = asArray(product['variants']);
    if (variants === null) return { ok: false, reason: 'no `product.variants` array in response' };

    const currency =
      readString(root['currency']) ??
      readString(product['currency']) ??
      readString(product['currency_code']) ??
      null;

    const snapshots: StockSnapshot[] = [];
    for (const entry of variants) {
      const snapshot = parseVariant(entry, currency, ctx.now, ctx.sourceId);
      if (snapshot !== null) snapshots.push(snapshot);
    }

    if (snapshots.length === 0) {
      return {
        ok: false,
        reason: 'variants array contained no variants with a derivable availability',
      };
    }
    return { ok: true, snapshots };
  },
};

function parseVariant(
  entry: unknown,
  currency: string | null,
  now: number,
  sourceId: SourceId,
): StockSnapshot | null {
  const v = asRecord(entry);
  if (v === null) return null;

  const variantId = readString(v['id']);
  if (variantId === null) return null;

  const available = resolveAvailability(v);
  if (available === null) return null;

  const title = readString(v['title']) ?? readString(v['name']) ?? `Variant ${variantId}`;
  // "899.00" -> 89900. Never `parseFloat(...) * 100`.
  const priceCents = parsePriceToCents(v['price']);

  // Shopify's own variant id: observed identifier and purchase alias coincide here, but the
  // namespace is recorded rather than assumed because that is not true of every adapter.
  return {
    variantId,
    observed: { sourceId, namespace: 'shopify-variant-id', externalId: variantId },
    title,
    available,
    priceCents,
    currency,
    checkedAt: now,
  };
}

/**
 * Shopify availability semantics, in precedence order:
 *   - explicit `available` boolean wins;
 *   - no `inventory_management` means the shop does not track stock for this variant, so it is
 *     always purchasable;
 *   - `inventory_policy === 'continue'` means overselling is allowed, so it is purchasable
 *     regardless of quantity;
 *   - otherwise fall back to `inventory_quantity > 0`;
 *   - otherwise return null (undeterminable) so the caller drops the variant.
 */
function resolveAvailability(v: Record<string, unknown>): boolean | null {
  const explicit = readBoolean(v['available']);
  if (explicit !== null) return explicit;

  const hasInventoryManagementKey = 'inventory_management' in v;
  const inventoryManagement = readString(v['inventory_management']);
  const inventoryPolicy = readString(v['inventory_policy']);
  const inventoryQuantity = readNumber(v['inventory_quantity']);

  if (hasInventoryManagementKey && inventoryManagement === null) return true;
  if (inventoryPolicy !== null && inventoryPolicy.toLowerCase() === 'continue') return true;
  if (inventoryQuantity !== null) return inventoryQuantity > 0;
  return null;
}
