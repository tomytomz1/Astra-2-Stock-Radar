/**
 * pnpm probe [url]
 *
 * The ONLY step in this project that touches the live store. Fingerprints `PRODUCT_URL` (or an
 * override passed on the command line) against every detection strategy in `ADAPTER_ORDER`,
 * prints a per-adapter report, and writes `worker/src/detect/config.json` (shape: `DetectConfig`
 * from `@astra/contract`) so the worker knows which adapter to trust at runtime without a code
 * change -- that file is the one write this script makes outside `scripts/**`, and it is
 * generated output, not hand-authored config.
 *
 * Deliberately standalone: no import from `worker/src/**`. The watcher agent owns the production
 * adapters and is writing them concurrently in this same tree; this script re-implements the
 * minimum parsing needed to fingerprint the store against the shared `@astra/contract` types.
 * Duplicating a little parsing logic here is intentional -- this is a diagnostic tool, not
 * production code, and it must keep working even if the production adapters are mid-rewrite.
 *
 * Run with:
 *   pnpm probe
 *   pnpm probe https://some-other-store.example.com/products/x   (override target for testing)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTER_ORDER, PRODUCT_TITLE, PRODUCT_URL } from '../packages/contract/src/index.js';
import type { AdapterName, DetectConfig, StockSnapshot } from '../packages/contract/src/index.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(SCRIPT_DIR, '..', 'worker', 'src', 'detect', 'config.json');

const TARGET_URL = process.argv[2] ?? PRODUCT_URL;
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Seed defaults written to config.json only on a first-ever run (no existing file). A real probe
// run always shows what it actually found on the page so these are a starting point, not a
// substitute for reading the report below.
const DEFAULT_SOLD_OUT_PATTERNS = ['sold\\s*out', 'out\\s*of\\s*stock', 'currently unavailable'];
const DEFAULT_IN_STOCK_PATTERNS = ['add to cart', 'add to bag', 'buy it now'];

// Common phrases across storefront themes, surfaced to help hand-tune soldOutPatterns /
// inStockPatterns. Not exhaustive -- a diagnostic aid, not a parser.
const CANDIDATE_PHRASES = [
  'sold out',
  'out of stock',
  'in stock',
  'add to cart',
  'add to bag',
  'buy it now',
  'unavailable',
  'notify me',
  'coming soon',
  'pre-order',
  'preorder',
  'available for sale',
  'back in stock',
];

// This script hand-implements the chain rather than importing ADAPTER_ORDER's runner, so this
// check is a tripwire: if the contract's order ever changes, the mismatch fails loudly here
// instead of silently probing in the wrong order.
const EXPECTED_ORDER: readonly AdapterName[] = ['shopify-js', 'shopify-json', 'jsonld', 'heuristic'];

interface RawFetch {
  status: number;
  contentType: string | null;
  bodyText: string;
}

interface AdapterReport {
  adapter: AdapterName;
  ok: boolean;
  reason: string | null;
  snapshots: StockSnapshot[];
  raw: RawFetch | null;
}

function log(line = ''): void {
  console.log(line);
}

function divider(): void {
  log('-'.repeat(72));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return `timed out after ${TIMEOUT_MS}ms`;
    return err.message;
  }
  return String(err);
}

async function timedFetch(url: string): Promise<RawFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,*/*',
      },
    });
    const bodyText = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type'), bodyText };
  } finally {
    clearTimeout(timer);
  }
}

function bodyPreview(text: string, chars = 500): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > chars ? `${collapsed.slice(0, chars)}…` : collapsed;
}

function centsFromDollars(value: unknown): number | null {
  const n =
    typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Adapter: shopify-js  --  GET {url}.js
// ---------------------------------------------------------------------------

async function probeShopifyJs(baseUrl: string): Promise<AdapterReport> {
  const adapter: AdapterName = 'shopify-js';
  const target = `${baseUrl.replace(/\/+$/, '')}.js`;
  let raw: RawFetch;
  try {
    raw = await timedFetch(target);
  } catch (err) {
    return { adapter, ok: false, reason: `fetch failed: ${errMessage(err)}`, snapshots: [], raw: null };
  }
  if (raw.status !== 200) {
    return { adapter, ok: false, reason: `HTTP ${raw.status} from ${target}`, snapshots: [], raw };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.bodyText);
  } catch (err) {
    return { adapter, ok: false, reason: `response is not JSON: ${errMessage(err)}`, snapshots: [], raw };
  }
  const product = json as { title?: unknown; variants?: unknown };
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    return { adapter, ok: false, reason: 'no `variants` array in response', snapshots: [], raw };
  }
  const checkedAt = Date.now();
  const snapshots: StockSnapshot[] = [];
  for (const entry of product.variants) {
    const v = entry as Record<string, unknown>;
    if (typeof v.id === 'undefined') continue;
    snapshots.push({
      variantId: String(v.id),
      title: typeof v.title === 'string' ? v.title : String(product.title ?? PRODUCT_TITLE),
      available: v.available === true,
      // The `.js` endpoint returns price as integer cents already, unlike `.json`.
      priceCents: typeof v.price === 'number' ? Math.round(v.price) : null,
      currency: typeof v.price_currency === 'string' ? v.price_currency : null,
      checkedAt,
    });
  }
  if (snapshots.length === 0) {
    return { adapter, ok: false, reason: 'variants array present but no usable entries', snapshots: [], raw };
  }
  return { adapter, ok: true, reason: null, snapshots, raw };
}

// ---------------------------------------------------------------------------
// Adapter: shopify-json  --  GET {url}.json
// ---------------------------------------------------------------------------

async function probeShopifyJson(baseUrl: string): Promise<AdapterReport> {
  const adapter: AdapterName = 'shopify-json';
  const target = `${baseUrl.replace(/\/+$/, '')}.json`;
  let raw: RawFetch;
  try {
    raw = await timedFetch(target);
  } catch (err) {
    return { adapter, ok: false, reason: `fetch failed: ${errMessage(err)}`, snapshots: [], raw: null };
  }
  if (raw.status !== 200) {
    return { adapter, ok: false, reason: `HTTP ${raw.status} from ${target}`, snapshots: [], raw };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.bodyText);
  } catch (err) {
    return { adapter, ok: false, reason: `response is not JSON: ${errMessage(err)}`, snapshots: [], raw };
  }
  const wrapper = json as { product?: unknown };
  const product = wrapper.product as { title?: unknown; variants?: unknown } | undefined;
  if (!product || !Array.isArray(product.variants) || product.variants.length === 0) {
    return { adapter, ok: false, reason: 'no `product.variants` array in response', snapshots: [], raw };
  }
  const checkedAt = Date.now();
  const snapshots: StockSnapshot[] = [];
  for (const entry of product.variants) {
    const v = entry as Record<string, unknown>;
    if (typeof v.id === 'undefined') continue;
    snapshots.push({
      variantId: String(v.id),
      title: typeof v.title === 'string' ? v.title : String(product.title ?? PRODUCT_TITLE),
      available: v.available === true,
      // The `.json` endpoint returns price as a decimal-dollar string (e.g. "899.00").
      priceCents: centsFromDollars(v.price),
      currency: null, // not exposed by this endpoint on most storefronts
      checkedAt,
    });
  }
  if (snapshots.length === 0) {
    return { adapter, ok: false, reason: 'variants array present but no usable entries', snapshots: [], raw };
  }
  return { adapter, ok: true, reason: null, snapshots, raw };
}

// ---------------------------------------------------------------------------
// Adapter: jsonld  --  <script type="application/ld+json"> on the product page
// ---------------------------------------------------------------------------

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Best-effort only: some themes emit malformed or concatenated JSON. Skip and move on.
    }
  }
  return blocks;
}

function flattenNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) flattenNodes(item, out);
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    out.push(obj);
    if (obj['@graph']) flattenNodes(obj['@graph'], out);
  }
  return out;
}

function isProductNode(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  if (typeof type === 'string') return type.toLowerCase() === 'product';
  if (Array.isArray(type)) return type.some((t) => typeof t === 'string' && t.toLowerCase() === 'product');
  return false;
}

function offersOf(node: Record<string, unknown>): Record<string, unknown>[] {
  const offers = node['offers'];
  if (!offers) return [];
  const list = Array.isArray(offers) ? offers : [offers];
  const out: Record<string, unknown>[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const offer = entry as Record<string, unknown>;
    if (offer['@type'] === 'AggregateOffer' && Array.isArray(offer['offers'])) {
      for (const sub of offer['offers'] as unknown[]) {
        if (sub && typeof sub === 'object') out.push(sub as Record<string, unknown>);
      }
    } else {
      out.push(offer);
    }
  }
  return out;
}

// Only `InStock` reads as purchasable. `PreOrder`/`BackOrder` mean "orderable, not shippable" --
// the wrong signal for a drop watcher, which wants "can add to cart right now". Mirrors the
// judgment call the production jsonld adapter makes (see worker/src/detect/jsonld.ts).
function availabilityToBool(value: unknown): boolean | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v.includes('instock')) return true;
  if (
    v.includes('outofstock') ||
    v.includes('soldout') ||
    v.includes('discontinued') ||
    v.includes('preorder') ||
    v.includes('backorder') ||
    v.includes('limitedavailability')
  ) {
    return false;
  }
  return null;
}

async function probeJsonLd(htmlRaw: RawFetch | null, htmlFetchError: string | null): Promise<AdapterReport> {
  const adapter: AdapterName = 'jsonld';
  if (!htmlRaw) {
    return {
      adapter,
      ok: false,
      reason: `could not fetch product page: ${htmlFetchError}`,
      snapshots: [],
      raw: null,
    };
  }
  if (htmlRaw.status !== 200) {
    return { adapter, ok: false, reason: `HTTP ${htmlRaw.status} fetching product page`, snapshots: [], raw: htmlRaw };
  }
  const blocks = extractJsonLdBlocks(htmlRaw.bodyText);
  if (blocks.length === 0) {
    return {
      adapter,
      ok: false,
      reason: 'no <script type="application/ld+json"> blocks found',
      snapshots: [],
      raw: htmlRaw,
    };
  }
  const nodes = blocks.flatMap((b) => flattenNodes(b));
  const productNodes = nodes.filter(isProductNode);
  if (productNodes.length === 0) {
    return {
      adapter,
      ok: false,
      reason: `found ${blocks.length} ld+json block(s) but none typed "Product"`,
      snapshots: [],
      raw: htmlRaw,
    };
  }
  const checkedAt = Date.now();
  const snapshots: StockSnapshot[] = [];
  productNodes.forEach((product, productIndex) => {
    offersOf(product).forEach((offer, offerIndex) => {
      const available = availabilityToBool(offer['availability']);
      if (available === null) return; // ambiguous -- refuse to guess, matches invariant 1's spirit
      const variantId =
        typeof offer['sku'] === 'string'
          ? (offer['sku'] as string)
          : typeof product['sku'] === 'string'
            ? `${product['sku']}-${offerIndex}`
            : `jsonld-${productIndex}-${offerIndex}`;
      const title =
        typeof offer['name'] === 'string'
          ? (offer['name'] as string)
          : typeof product['name'] === 'string'
            ? (product['name'] as string)
            : PRODUCT_TITLE;
      snapshots.push({
        variantId,
        title,
        available,
        priceCents: centsFromDollars(offer['price']),
        currency: typeof offer['priceCurrency'] === 'string' ? (offer['priceCurrency'] as string) : null,
        checkedAt,
      });
    });
  });
  if (snapshots.length === 0) {
    return {
      adapter,
      ok: false,
      reason: 'Product node(s) found but no offer had a resolvable availability',
      snapshots: [],
      raw: htmlRaw,
    };
  }
  return { adapter, ok: true, reason: null, snapshots, raw: htmlRaw };
}

// ---------------------------------------------------------------------------
// Adapter: heuristic  --  regex pattern matching over the raw product page HTML
// ---------------------------------------------------------------------------

function slugFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'product';
  } catch {
    return 'product';
  }
}

function compileSafe(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

async function probeHeuristic(
  htmlRaw: RawFetch | null,
  htmlFetchError: string | null,
  targetUrl: string,
  config: DetectConfig,
): Promise<AdapterReport> {
  const adapter: AdapterName = 'heuristic';
  if (!htmlRaw) {
    return {
      adapter,
      ok: false,
      reason: `could not fetch product page: ${htmlFetchError}`,
      snapshots: [],
      raw: null,
    };
  }
  if (htmlRaw.status !== 200) {
    return { adapter, ok: false, reason: `HTTP ${htmlRaw.status} fetching product page`, snapshots: [], raw: htmlRaw };
  }

  const soldOutSource = config.soldOutPatterns.length > 0 ? config.soldOutPatterns : DEFAULT_SOLD_OUT_PATTERNS;
  const inStockSource = config.inStockPatterns.length > 0 ? config.inStockPatterns : DEFAULT_IN_STOCK_PATTERNS;
  const soldOutPatterns = soldOutSource.map(compileSafe).filter((r): r is RegExp => r !== null);
  const inStockPatterns = inStockSource.map(compileSafe).filter((r): r is RegExp => r !== null);

  const soldOutHit = soldOutPatterns.some((r) => r.test(htmlRaw.bodyText));
  const inStockHit = inStockPatterns.some((r) => r.test(htmlRaw.bodyText));

  let available: boolean | null;
  if (soldOutHit && !inStockHit) available = false;
  else if (inStockHit && !soldOutHit) available = true;
  else available = null; // ambiguous or contradictory -- refuse to guess, not "assume in stock"

  if (available === null) {
    return {
      adapter,
      ok: false,
      reason:
        soldOutHit && inStockHit
          ? 'both sold-out and in-stock patterns matched -- patterns are ambiguous, refine them'
          : 'no configured sold-out/in-stock pattern matched this page',
      snapshots: [],
      raw: htmlRaw,
    };
  }

  const snapshot: StockSnapshot = {
    variantId: slugFromUrl(targetUrl),
    title: PRODUCT_TITLE,
    available,
    priceCents: null,
    currency: null,
    checkedAt: Date.now(),
  };
  return { adapter, ok: true, reason: null, snapshots: [snapshot], raw: htmlRaw };
}

// ---------------------------------------------------------------------------
// Candidate pattern discovery (printed when the first three adapters fail)
// ---------------------------------------------------------------------------

function findCandidatePhrases(html: string): Array<{ phrase: string; count: number; sample: string }> {
  const text = html.replace(/\s+/g, ' ');
  const results: Array<{ phrase: string; count: number; sample: string }> = [];
  for (const phrase of CANDIDATE_PHRASES) {
    const re = new RegExp(escapeRegExp(phrase), 'gi');
    const matches = [...text.matchAll(re)];
    if (matches.length === 0) continue;
    const first = matches[0];
    const idx = first?.index ?? 0;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + phrase.length + 40);
    results.push({ phrase, count: matches.length, sample: text.slice(start, end).trim() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printReport(report: AdapterReport): void {
  divider();
  log(`${report.adapter}  --  ${report.ok ? 'OK' : 'FAILED'}`);
  if (report.raw) {
    log(`  HTTP ${report.raw.status}  content-type: ${report.raw.contentType ?? '(none)'}`);
  }
  if (!report.ok) {
    log(`  reason: ${report.reason}`);
    if (report.raw) {
      log(`  body preview (first ~500 chars): ${bodyPreview(report.raw.bodyText)}`);
    }
    return;
  }
  log(`  ${report.snapshots.length} variant(s):`);
  for (const s of report.snapshots) {
    const price = s.priceCents != null ? `${(s.priceCents / 100).toFixed(2)} ${s.currency ?? ''}`.trim() : 'unknown price';
    log(`    - [${s.available ? 'IN STOCK' : 'sold out'}] ${s.variantId}  "${s.title}"  ${price}`);
  }
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

async function loadExistingConfig(): Promise<DetectConfig> {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(text) as Partial<DetectConfig>;
    return {
      preferredAdapter: parsed.preferredAdapter ?? null,
      soldOutPatterns: Array.isArray(parsed.soldOutPatterns) ? parsed.soldOutPatterns : [],
      inStockPatterns: Array.isArray(parsed.inStockPatterns) ? parsed.inStockPatterns : [],
      probedAt: parsed.probedAt ?? null,
    };
  } catch {
    return { preferredAdapter: null, soldOutPatterns: [], inStockPatterns: [], probedAt: null };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (JSON.stringify(EXPECTED_ORDER) !== JSON.stringify(ADAPTER_ORDER)) {
    log('WARNING: ADAPTER_ORDER in @astra/contract no longer matches the order this script');
    log('probes in. Update EXPECTED_ORDER (and the probe functions) in scripts/probe.ts.');
    divider();
  }

  log(`Probing ${TARGET_URL}`);
  log('(override the target with: pnpm probe <url>)');

  const existingConfig = await loadExistingConfig();
  const reports: AdapterReport[] = [];

  reports.push(await probeShopifyJs(TARGET_URL));
  reports.push(await probeShopifyJson(TARGET_URL));

  let htmlRaw: RawFetch | null = null;
  let htmlFetchError: string | null = null;
  try {
    htmlRaw = await timedFetch(TARGET_URL);
  } catch (err) {
    htmlFetchError = errMessage(err);
  }

  // jsonld and heuristic both read the same product-page HTML; one fetch, two adapters.
  reports.push(await probeJsonLd(htmlRaw, htmlFetchError));
  reports.push(await probeHeuristic(htmlRaw, htmlFetchError, TARGET_URL, existingConfig));

  for (const r of reports) printReport(r);
  divider();

  const firstSuccess = reports.find((r) => r.ok) ?? null;
  const firstThreeAllFailed = reports.slice(0, 3).every((r) => !r.ok);

  if (firstSuccess) {
    log(`RESULT: "${firstSuccess.adapter}" works. Writing it as the preferred adapter.`);
  } else {
    log('RESULT: every adapter failed. See per-adapter reasons above.');
    if (htmlRaw && /just a moment|cf-chl|attention required|captcha|checking your browser/i.test(htmlRaw.bodyText)) {
      log('');
      log('This looks like a bot-challenge page (e.g. Cloudflare), not the real store front-end.');
      log('A plain server-side fetch cannot pass a JS challenge. Options:');
      log('  - Open the URL in a real browser once and see if it is only shown to new/unusual IPs.');
      log('  - Check whether the storefront has a "please enable JavaScript" fallback that a real');
      log('    browser never sees, vs. this being shown to every visitor (in which case none of');
      log('    these adapters, nor the worker built on them, can watch this store as-is).');
    }
  }

  if (htmlRaw && htmlRaw.status === 200 && firstThreeAllFailed) {
    const candidates = findCandidatePhrases(htmlRaw.bodyText);
    divider();
    log('Candidate stock-related phrases found on the page (for soldOutPatterns / inStockPatterns');
    log(`in ${CONFIG_PATH}):`);
    if (candidates.length === 0) {
      log('  (none of the common phrases were found -- inspect the page manually in a browser)');
    } else {
      for (const c of candidates) {
        log(`  "${c.phrase}"  x${c.count}  e.g. …${c.sample}…`);
      }
    }
  }

  const config: DetectConfig = {
    preferredAdapter: firstSuccess?.adapter ?? null,
    soldOutPatterns: existingConfig.soldOutPatterns.length > 0 ? existingConfig.soldOutPatterns : DEFAULT_SOLD_OUT_PATTERNS,
    inStockPatterns: existingConfig.inStockPatterns.length > 0 ? existingConfig.inStockPatterns : DEFAULT_IN_STOCK_PATTERNS,
    probedAt: new Date().toISOString(),
  };

  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  divider();
  log(`Wrote ${CONFIG_PATH}`);
  log(`  preferredAdapter: ${config.preferredAdapter ?? 'null (worker will try the whole chain, in order)'}`);
  log(`  probedAt: ${config.probedAt}`);
  if (!firstSuccess) {
    log('  NOTE: no adapter succeeded this run. Fix soldOutPatterns/inStockPatterns (or whatever');
    log('  the diagnostics above point at) and re-run `pnpm probe` before deploying the worker --');
    log('  deploying with every adapter broken means the cron pass will never see a restock.');
  }

  process.exitCode = firstSuccess ? 0 : 1;
}

main().catch((err) => {
  console.error('probe crashed unexpectedly:', err);
  process.exitCode = 1;
});
