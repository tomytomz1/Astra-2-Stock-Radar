import { PRODUCT_TITLE } from '@astra/contract';
import type { StockSnapshot } from '@astra/contract';
import type { Adapter, AdapterContext, AdapterResult } from './types';
import { browserHeaders, errorMessage, fetchWithTimeout, rateLimitedFailure } from './util';

/**
 * Last-resort HTML pattern matching, driven entirely by `DetectConfig` written by `pnpm probe`.
 *
 * Two deliberate constraints:
 *   1. With no configured patterns this adapter REPORTS FAILURE instead of guessing. A guess
 *      here becomes a `false` in KV, and a wrong `false` is the phantom-alert bug (invariant 1).
 *   2. It emits ONE synthetic variant. HTML scraping has no reliable per-variant identity, and
 *      inventing unstable ids would make every theme tweak look like a restock.
 *
 * Never promote this above the structured adapters: theme changes break it silently.
 */
export const heuristicAdapter: Adapter = {
  name: 'heuristic',
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const soldOut = compilePatterns(ctx.config.soldOutPatterns);
    const inStock = compilePatterns(ctx.config.inStockPatterns);

    if (soldOut.length === 0 && inStock.length === 0) {
      // Fail before spending a fetch: no patterns means no opinion.
      return {
        ok: false,
        reason:
          ctx.config.soldOutPatterns.length + ctx.config.inStockPatterns.length > 0
            ? 'every configured pattern failed to compile as a regex'
            : 'no soldOutPatterns/inStockPatterns configured; refusing to guess',
      };
    }

    let html: string;
    try {
      const res = await fetchWithTimeout(
        ctx.fetchImpl,
        ctx.productUrl,
        { method: 'GET', headers: browserHeaders('text/html,application/xhtml+xml') },
        ctx.timeoutMs,
      );
      // A 429 is about the host, not this path: sibling endpoints share the bucket.
      const throttled = rateLimitedFailure(res, ctx.productUrl);
      if (throttled !== null) return throttled;
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${ctx.productUrl}` };
      html = await res.text();
    } catch (err) {
      return { ok: false, reason: `fetch failed for ${ctx.productUrl}: ${errorMessage(err)}` };
    }
    if (html.trim() === '') return { ok: false, reason: 'empty HTML body' };

    const soldOutHit = soldOut.some((re) => re.test(html));
    const inStockHit = inStock.some((re) => re.test(html));

    // Precedence: an explicit sold-out marker beats an in-stock marker, because "Add to cart"
    // markup is often present-but-disabled on sold-out pages.
    let available: boolean;
    if (soldOutHit) available = false;
    else if (inStockHit) available = true;
    else if (inStock.length === 0) available = true; // only sold-out markers configured, none matched
    else available = false;

    const snapshot: StockSnapshot = {
      variantId: syntheticVariantId(ctx.productUrl),
      title: PRODUCT_TITLE,
      available,
      priceCents: null,
      currency: null,
      checkedAt: ctx.now,
    };
    return { ok: true, snapshots: [snapshot] };
  },
};

function compilePatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      // A bad regex from config is skipped, not fatal — the remaining patterns still work.
    }
  }
  return compiled;
}

/** Slug of the product URL's last path segment, e.g. `redmagic-astra-2-gaming-tablet`. */
export function syntheticVariantId(productUrl: string): string {
  const withoutQuery = productUrl.split(/[?#]/)[0] ?? productUrl;
  const segments = withoutQuery.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  const slug = (last ?? 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'product' : slug;
}
