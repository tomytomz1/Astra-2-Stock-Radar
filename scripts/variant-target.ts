/**
 * Which variant ids a force-alert can actually fire for.
 *
 * Split out of `simulate-restock.ts` so it can be exercised without wrangler or Cloudflare
 * credentials — the same reason `eas-json.ts` exists. The bug this prevents was found by a human
 * waiting for a notification that could never arrive, which is the worst way to find anything.
 */

import type { StockSnapshot } from '../packages/contract/src/index.js';

export interface SnapshotCache {
  snapshots: StockSnapshot[];
  updatedAt: number;
}

export type TargetCheck =
  | { ok: true }
  /** No cache to check against — a worker that has never completed a successful pass. */
  | { ok: false; reason: 'no-cache' }
  | { ok: false; reason: 'unknown-variant'; live: StockSnapshot[] };

/**
 * Validate a force-alert target against the worker's last successful reading.
 *
 * The worker only alerts for a variant present in the pass's snapshots, so a trigger naming
 * anything else is consumed and discarded without sending — correct behaviour, and indisting-
 * uishable from success at the point of arming. Checking here turns a silent no-op into a
 * refusal.
 *
 * A missing cache is NOT a rejection: the worker may simply not have succeeded yet, and refusing
 * every id in that state would break the tool exactly when someone is trying to diagnose a
 * worker that is not working.
 */
export function checkTarget(cache: SnapshotCache | null, variantId: string): TargetCheck {
  if (cache === null || cache.snapshots.length === 0) return { ok: false, reason: 'no-cache' };
  const known = cache.snapshots.some((s) => s.variantId === variantId);
  return known ? { ok: true } : { ok: false, reason: 'unknown-variant', live: cache.snapshots };
}

/** `<id>  Eclipse / 12GB+256GB  [out of stock]` — id alone is not enough to pick from. */
export function describeSnapshot(snapshot: StockSnapshot): string {
  const state = snapshot.available ? 'IN STOCK' : 'out of stock';
  return `  ${snapshot.variantId}  ${snapshot.title}  [${state}]`;
}

/** Tolerant parse: a cache written by an older worker, or absent, must not throw. */
export function parseSnapshotCache(raw: string | null): SnapshotCache | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotCache>;
    if (!Array.isArray(parsed.snapshots)) return null;
    return { snapshots: parsed.snapshots, updatedAt: parsed.updatedAt ?? 0 };
  } catch {
    return null;
  }
}
