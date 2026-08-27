import type { FetchInit, FetchLike, FetchResponse } from './types';

/** Storefronts routinely 403 obvious bots. Present as a normal desktop browser. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch with a hard deadline. A hung socket must not stall the cron pass: the next minute's
 * pass is more valuable than this one finishing.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: FetchInit,
  timeoutMs: number,
): Promise<FetchResponse> {
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function browserHeaders(accept: string): Record<string, string> {
  return {
    'user-agent': USER_AGENT,
    accept,
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Defensive readers — every field from the store is `unknown` until proven otherwise
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

export function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Normalise a human/JSON price into a plain `-?ddd(.ddd)` decimal string, or null.
 *
 * Handles `"$1,299.00"`, `"1.299,00"`, `"899.00"` and bare numbers.
 */
function normalizeDecimal(raw: string): string | null {
  let s = raw.replace(/[\s ]/g, '').replace(/[^0-9.,-]/g, '');
  if (s === '') return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Whichever separator comes last is the decimal separator.
    const decimalIsDot = lastDot > lastComma;
    s = decimalIsDot ? s.split(',').join('') : s.split('.').join('').replace(',', '.');
  } else if (lastComma >= 0) {
    // Ambiguous: "1,299" (thousands) vs "12,99" (decimal). Exactly two trailing digits reads
    // as a decimal separator; anything else reads as a thousands separator.
    const trailing = s.length - lastComma - 1;
    s = trailing === 2 ? s.replace(',', '.') : s.split(',').join('');
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/**
 * Convert a price to integer minor units WITHOUT floating point multiplication.
 *
 * `Math.round(8.99 * 100)` happens to work but `parseFloat("1.005") * 100` is 100.49999...;
 * relying on that is how off-by-one-cent bugs get in. Integer string arithmetic instead:
 * the fractional part is padded/truncated to two digits and added to `whole * 100`, which is
 * exact for every price a storefront can express.
 */
export function parsePriceToCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // `String(n)` is the shortest round-tripping decimal form, so it re-enters exact-string land.
    raw = String(value);
  } else if (typeof value === 'string') {
    raw = value;
  } else {
    return null;
  }

  const decimal = normalizeDecimal(raw);
  if (decimal === null) return null;

  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const [whole = '0', fractionRaw = ''] = body.split('.');
  const fraction = (fractionRaw + '00').slice(0, 2);
  let cents = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) return null;
  // Round half-up on the third decimal digit (e.g. "0.005" -> 1 cent).
  const thirdDigit = fractionRaw.length > 2 ? Number(fractionRaw[2]) : 0;
  if (thirdDigit >= 5) cents += 1;
  return negative ? -cents : cents;
}
