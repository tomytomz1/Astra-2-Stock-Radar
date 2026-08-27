import { ADAPTER_ORDER } from '@astra/contract';
import type { AdapterName, DetectConfig } from '@astra/contract';
import rawConfig from './config.json';
import { asRecord } from './util';

/**
 * `config.json` is REWRITTEN by `pnpm probe` against the live store, so its contents are not
 * trustworthy at compile time — a probe could write `"preferredAdapter": "shopify-graphql"` and
 * TypeScript would never see it. Everything is validated at load, and anything unrecognised
 * degrades to "try the whole chain", which is always safe.
 */
export function coerceDetectConfig(input: unknown): DetectConfig {
  const record = asRecord(input);
  if (record === null) return FALLBACK_CONFIG;
  return {
    preferredAdapter: coerceAdapterName(record['preferredAdapter']),
    soldOutPatterns: coerceStringArray(record['soldOutPatterns']),
    inStockPatterns: coerceStringArray(record['inStockPatterns']),
    probedAt: typeof record['probedAt'] === 'string' ? record['probedAt'] : null,
  };
}

export const FALLBACK_CONFIG: DetectConfig = {
  preferredAdapter: null,
  soldOutPatterns: [],
  inStockPatterns: [],
  probedAt: null,
};

/** The config this deployment ships with. */
export const detectConfig: DetectConfig = coerceDetectConfig(rawConfig);

function coerceAdapterName(value: unknown): AdapterName | null {
  if (typeof value !== 'string') return null;
  const match = ADAPTER_ORDER.find((name) => name === value);
  return match ?? null;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}
