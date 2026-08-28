import { describe, expect, it } from 'vitest';
import { REDMAGIC_SOURCE_ID } from '@astra/contract';
import type { DetectConfig } from '@astra/contract';
import { detect, resolveOrder } from '../src/detect/index';
import { coerceDetectConfig } from '../src/detect/config';
import { heuristicAdapter } from '../src/detect/heuristic';
import { jsonLdAdapter } from '../src/detect/jsonld';
import { shopifyJsAdapter } from '../src/detect/shopify-js';
import { shopifyJsonAdapter } from '../src/detect/shopify-json';
import { parsePriceToCents } from '../src/detect/util';
import type { AdapterContext } from '../src/detect/types';
import { errorResponse, fakeFetch, fixture, jsonFixture, jsonResponse, textResponse } from './helpers';

const PRODUCT_URL = 'https://global.redmagic.gg/products/redmagic-astra-2-gaming-tablet';
const NOW = 1_772_000_000_000;

const EMPTY_CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

function ctx(fetchImpl: AdapterContext['fetchImpl'], config: DetectConfig = EMPTY_CONFIG): AdapterContext {
  return { sourceId: REDMAGIC_SOURCE_ID, productUrl: PRODUCT_URL, config, fetchImpl, now: NOW, timeoutMs: 1000 };
}

describe('shopify-js adapter', () => {
  it('parses variants, availability and integer-cent prices', async () => {
    const http = fakeFetch(() => jsonResponse(jsonFixture('shopify-js.available.json')));
    const result = await shopifyJsAdapter.run(ctx(http.fetchImpl));

    expect(http.calls[0]?.url).toBe(`${PRODUCT_URL}.js`);
    expect(http.calls[0]?.init?.headers?.['user-agent']).toMatch(/Mozilla/);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots[0]).toEqual({
      variantId: '44892134567001',
      // Shopify's `.js` always yields a Shopify variant id, whatever the value looks like.
      observed: {
        sourceId: REDMAGIC_SOURCE_ID,
        namespace: 'shopify-variant-id',
        externalId: '44892134567001',
      },
      title: 'Silver / 16GB + 512GB',
      available: true,
      // The `.js` endpoint already returns cents; it must not be multiplied again.
      priceCents: 89900,
      currency: null,
      checkedAt: NOW,
    });
    expect(result.snapshots.map((s) => s.available)).toEqual([true, false, false]);
  });

  it('treats an all-sold-out page as SUCCESS, not failure (invariant 1)', async () => {
    const http = fakeFetch(() => jsonResponse(jsonFixture('shopify-js.soldout.json')));
    const result = await shopifyJsAdapter.run(ctx(http.fetchImpl));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots.every((s) => !s.available)).toBe(true);
  });

  it('fails on non-2xx', async () => {
    const http = fakeFetch(() => errorResponse(503));
    const result = await shopifyJsAdapter.run(ctx(http.fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('503');
  });

  it('fails when the payload has no parsable variants', async () => {
    const http = fakeFetch(() => jsonResponse({ variants: [{ nope: true }] }));
    const result = await shopifyJsAdapter.run(ctx(http.fetchImpl));
    expect(result.ok).toBe(false);
  });
});

describe('shopify-json adapter', () => {
  it('converts decimal-string prices to cents exactly and derives availability', async () => {
    const http = fakeFetch(() => jsonResponse(jsonFixture('shopify-json.available.json')));
    const result = await shopifyJsonAdapter.run(ctx(http.fetchImpl));

    expect(http.calls[0]?.url).toBe(`${PRODUCT_URL}.json`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots.map((s) => s.priceCents)).toEqual([89900, 109950, 89999]);
    expect(result.snapshots.map((s) => s.available)).toEqual([
      true, // inventory_quantity 7, policy deny
      false, // inventory_quantity 0, policy deny
      true, // inventory_management null => untracked => always purchasable
    ]);
  });

  it('fails rather than guessing when no availability signal exists', async () => {
    const http = fakeFetch(() => jsonResponse(jsonFixture('shopify-json.no-availability.json')));
    const result = await shopifyJsonAdapter.run(ctx(http.fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('availability');
  });

  it('honours an explicit `available` boolean and `inventory_policy: continue`', async () => {
    const http = fakeFetch(() =>
      jsonResponse({
        product: {
          variants: [
            { id: 1, title: 'A', price: '10.00', available: false, inventory_quantity: 99 },
            { id: 2, title: 'B', price: '10.00', inventory_management: 'shopify', inventory_policy: 'continue', inventory_quantity: 0 },
          ],
        },
      }),
    );
    const result = await shopifyJsonAdapter.run(ctx(http.fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots.map((s) => s.available)).toEqual([false, true]);
  });
});

describe('parsePriceToCents', () => {
  it('is exact for decimal strings', () => {
    expect(parsePriceToCents('899.00')).toBe(89900);
    expect(parsePriceToCents('1099.50')).toBe(109950);
    expect(parsePriceToCents('899.99')).toBe(89999);
    expect(parsePriceToCents('0.10')).toBe(10);
    expect(parsePriceToCents('0.07')).toBe(7);
    expect(parsePriceToCents('1234.56')).toBe(123456);
  });

  it('avoids binary floating point error', () => {
    // The naive `parseFloat(x) * 100` implementations return 100.49999999999999 and 1000.9999...
    expect(parsePriceToCents('1.005')).toBe(101);
    expect(parsePriceToCents('10.01')).toBe(1001);
    expect(parsePriceToCents('870.05')).toBe(87005);
    expect(parsePriceToCents('1.115')).toBe(112);
  });

  it('handles numbers, symbols and thousands separators', () => {
    expect(parsePriceToCents(899)).toBe(89900);
    expect(parsePriceToCents(899.99)).toBe(89999);
    expect(parsePriceToCents('$1,299.99')).toBe(129999);
    expect(parsePriceToCents('1.299,00')).toBe(129900);
    expect(parsePriceToCents('12,99')).toBe(1299);
  });

  it('returns null for unparsable input', () => {
    expect(parsePriceToCents(null)).toBeNull();
    expect(parsePriceToCents(undefined)).toBeNull();
    expect(parsePriceToCents('sold out')).toBeNull();
    expect(parsePriceToCents({})).toBeNull();
    expect(parsePriceToCents(Number.NaN)).toBeNull();
  });
});

describe('jsonld adapter', () => {
  it('reads offers from a @graph wrapper and maps schema.org availability', async () => {
    const http = fakeFetch(() => textResponse(fixture('jsonld.available.html')));
    const result = await jsonLdAdapter.run(ctx(http.fetchImpl));

    expect(http.calls[0]?.url).toBe(PRODUCT_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots[0]).toEqual({
      variantId: 'RM-ASTRA2-SL-16-512',
      // Read from the offer's `sku` field, so the namespace is `source-sku` -- and note the value
      // is an alphanumeric part code, not a barcode. This is precisely why the namespace names the
      // FIELD rather than claiming a format: an `sku-ean` label would be false here.
      observed: {
        sourceId: REDMAGIC_SOURCE_ID,
        namespace: 'source-sku',
        externalId: 'RM-ASTRA2-SL-16-512',
      },
      title: 'Silver / 16GB + 512GB',
      available: true,
      priceCents: 89900,
      currency: 'USD',
      checkedAt: NOW,
    });
    // OutOfStock -> false, and PreOrder is deliberately NOT purchasable.
    expect(result.snapshots.map((s) => s.available)).toEqual([true, false, false]);
  });

  it('handles a single AggregateOffer, an @id availability node and a malformed sibling block', async () => {
    const http = fakeFetch(() => textResponse(fixture('jsonld.aggregate-soldout.html')));
    const result = await jsonLdAdapter.run(ctx(http.fetchImpl));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.available).toBe(false);
    expect(result.snapshots[0]?.priceCents).toBe(89900);
    expect(result.snapshots[0]?.currency).toBe('USD');
  });

  it('fails when the page has no ld+json', async () => {
    const http = fakeFetch(() => textResponse('<html><body>nothing here</body></html>'));
    const result = await jsonLdAdapter.run(ctx(http.fetchImpl));
    expect(result.ok).toBe(false);
  });
});

describe('heuristic adapter', () => {
  const configured: DetectConfig = {
    preferredAdapter: null,
    soldOutPatterns: ['>\\s*Sold out\\s*<'],
    inStockPatterns: ['>\\s*Add to cart\\s*<'],
    probedAt: '2026-08-01T00:00:00.000Z',
  };

  it('refuses to guess (and does not even fetch) with no configured patterns', async () => {
    const http = fakeFetch(() => textResponse(fixture('heuristic.available.html')));
    const result = await heuristicAdapter.run(ctx(http.fetchImpl));

    expect(result.ok).toBe(false);
    expect(http.calls).toHaveLength(0);
  });

  it('reports a single synthetic variant as unavailable when a sold-out pattern matches', async () => {
    const http = fakeFetch(() => textResponse(fixture('heuristic.soldout.html')));
    const result = await heuristicAdapter.run(ctx(http.fetchImpl, configured));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.variantId).toBe('redmagic-astra-2-gaming-tablet');
    expect(result.snapshots[0]?.available).toBe(false);
  });

  it('reports available when only an in-stock pattern matches', async () => {
    const http = fakeFetch(() => textResponse(fixture('heuristic.available.html')));
    const result = await heuristicAdapter.run(ctx(http.fetchImpl, configured));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots[0]?.available).toBe(true);
  });
});

describe('adapter chain', () => {
  it('falls through failing adapters to the first working one', async () => {
    const http = fakeFetch((url) => {
      if (url.endsWith('.js')) return errorResponse(404);
      if (url.endsWith('.json')) return errorResponse(404);
      return textResponse(fixture('jsonld.available.html'));
    });

    const result = await detect({ productUrl: PRODUCT_URL, config: EMPTY_CONFIG, fetchImpl: http.fetchImpl, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapter).toBe('jsonld');
    expect(result.snapshots).toHaveLength(3);
    expect(http.calls.map((c) => c.url)).toEqual([
      `${PRODUCT_URL}.js`,
      `${PRODUCT_URL}.json`,
      PRODUCT_URL,
    ]);
  });

  it('returns ok:false with every reason when the whole chain fails', async () => {
    const http = fakeFetch(() => errorResponse(500));
    const result = await detect({ productUrl: PRODUCT_URL, config: EMPTY_CONFIG, fetchImpl: http.fetchImpl, now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.adapter).toBeNull();
    expect(result.reason).toContain('shopify-js');
    expect(result.reason).toContain('shopify-json');
    expect(result.reason).toContain('jsonld');
    expect(result.reason).toContain('heuristic');
  });

  it('does not fail the pass when an adapter throws', async () => {
    const http = fakeFetch((url) => {
      if (url.endsWith('.js')) throw new Error('boom');
      return jsonResponse(jsonFixture('shopify-json.available.json'));
    });
    const result = await detect({ productUrl: PRODUCT_URL, config: EMPTY_CONFIG, fetchImpl: http.fetchImpl, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapter).toBe('shopify-json');
  });

  it('tries the preferred adapter first but still falls back', async () => {
    expect(resolveOrder('jsonld')).toEqual(['jsonld', 'shopify-js', 'shopify-json', 'heuristic']);

    const config: DetectConfig = { ...EMPTY_CONFIG, preferredAdapter: 'jsonld' };
    const http = fakeFetch((url) => {
      if (url === PRODUCT_URL) return errorResponse(403);
      if (url.endsWith('.js')) return jsonResponse(jsonFixture('shopify-js.available.json'));
      return errorResponse(404);
    });

    const result = await detect({ productUrl: PRODUCT_URL, config, fetchImpl: http.fetchImpl, now: NOW });
    expect(http.calls[0]?.url).toBe(PRODUCT_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapter).toBe('shopify-js');
  });
});

describe('detect config loading', () => {
  it('degrades an unknown preferredAdapter written by the probe to "whole chain"', () => {
    const config = coerceDetectConfig({
      preferredAdapter: 'shopify-graphql',
      soldOutPatterns: ['sold out', 42],
      inStockPatterns: null,
      probedAt: 7,
    });
    expect(config).toEqual({
      preferredAdapter: null,
      soldOutPatterns: ['sold out'],
      inStockPatterns: [],
      probedAt: null,
    });
  });

  it('accepts a valid probe result', () => {
    const config = coerceDetectConfig({
      preferredAdapter: 'shopify-js',
      soldOutPatterns: [],
      inStockPatterns: [],
      probedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(config.preferredAdapter).toBe('shopify-js');
    expect(config.probedAt).toBe('2026-08-27T00:00:00.000Z');
  });
});
