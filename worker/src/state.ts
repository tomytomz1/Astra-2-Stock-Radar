import {
  HEARTBEAT_INTERVAL_MS,
  ALERT_COOLDOWN_MS,
  DETECTOR_PAGE_COOLDOWN_MS,
  FAILURE_ALERT_THRESHOLD,
  KV_KEYS,
} from '@astra/contract';
import type { AdapterName, HealthState, StockSnapshot, VariantState } from '@astra/contract';
import { getJson, putJson, type KVStore } from './kv';

/**
 * ---------------------------------------------------------------------------
 * KV WRITE BUDGET (invariant 3)
 * ---------------------------------------------------------------------------
 * The cron runs every minute: 1440 passes/day against a 1000 writes/day free-tier limit. So a
 * pass in which nothing changed must perform ZERO writes. Concretely:
 *   - variant state: written only when `available` flips or an alert is recorded;
 *   - health: written only when failures start/stop, the adapter changes, or the periodic
 *     freshness refresh is due (at most 288 writes/day, see `HEALTH_REFRESH_MS`);
 *   - snapshot cache: written only when the MATERIAL content (ids/titles/availability/price)
 *     changes -- `checkedAt` alone changing is not a reason to write.
 * Reads are 100k/day and are not rationed, so read-then-compare is always the right shape.
 */

/**
 * Cache of the last materially-different snapshot set, used to answer `GET /status` without
 * hitting the store on every request. Worker-internal, so it is not in the shared `KV_KEYS`.
 */
export const SNAPSHOT_CACHE_KEY = 'cache:snapshots';

/**
 * How stale `HealthState.lastSuccessAt` is allowed to get before we spend a write refreshing it.
 *
 * Writing it every successful pass would cost 1440 writes/day on its own -- over budget before a
 * single restock is recorded. But this value is what the app renders as "Last checked N ago", so
 * pushing it too far the other way makes a perfectly healthy watcher look dead. Five minutes is
 * the compromise: at most 288 writes/day (~29% of the free tier), leaving ~700 for variant
 * transitions, snapshot-cache updates and device registrations, while the app's staleness never
 * exceeds five minutes.
 */
export const HEALTH_REFRESH_MS = 5 * 60 * 1000;

export interface ApplyResult {
  /** Snapshots that just latched false -> true and are outside their cooldown. */
  alerts: StockSnapshot[];
}

/**
 * Compare a successful detection pass against KV and latch transitions.
 *
 * ONLY call this with snapshots from a `{ok: true}` detect result. A failed detection must not
 * reach this function at all -- see `runPass`.
 */
export async function applySnapshots(
  kv: KVStore,
  snapshots: StockSnapshot[],
  now: number,
): Promise<ApplyResult> {
  const alerts: StockSnapshot[] = [];

  for (const snapshot of snapshots) {
    const key = KV_KEYS.variantState(snapshot.variantId);
    const previous = await getJson<VariantState>(kv, key);

    // Invariant 2: fire on the FIRST observed `true`. No confirmation pass -- a drop's whole
    // window can be shorter than the 60s a second poll would cost. A false positive wastes one
    // notification; a false negative loses the purchase.
    const isFirstObservation = previous === null;
    const roseToAvailable = snapshot.available && (isFirstObservation || !previous.available);

    const lastAlertedAt = previous?.lastAlertedAt ?? null;
    const withinCooldown = lastAlertedAt !== null && now - lastAlertedAt < ALERT_COOLDOWN_MS;
    const shouldAlert = roseToAvailable && !withinCooldown;

    const availabilityChanged = isFirstObservation || previous.available !== snapshot.available;

    if (shouldAlert) alerts.push(snapshot);

    // Invariant 3: no change, no write. `true -> true` and `false -> false` are free.
    if (!availabilityChanged && !shouldAlert) continue;

    const next: VariantState = {
      available: snapshot.available,
      lastAlertedAt: shouldAlert ? now : lastAlertedAt,
      lastChangedAt: availabilityChanged ? now : (previous?.lastChangedAt ?? now),
    };
    await putJson(kv, key, next);
  }

  return { alerts };
}

export async function readHealth(kv: KVStore): Promise<HealthState | null> {
  return getJson<HealthState>(kv, KV_KEYS.health);
}

export interface SuccessResult {
  /** Whether KV was actually touched. */
  wrote: boolean;
  /**
   * True when the caller owes the user a `detector-recovered` push: we paged about an outage and
   * this pass ended it. False for a success that merely follows failures nobody was told about.
   */
  recoveryNoticeDue: boolean;
  /**
   * True when a liveness heartbeat is owed. Decided here because this function already reads the
   * health record, so the check costs no extra KV reads.
   */
  heartbeatDue: boolean;
}

/**
 * Record a successful pass. Writes only when something meaningful changed (see budget above).
 *
 * `lastPagedAt` doubles as "an outage we paged about is currently open", so a non-null value here
 * is the whole recovery signal -- and it is cleared by the write below, which is what makes the
 * recovery notice fire exactly once. A success after failures we never paged about returns
 * `recoveryNoticeDue: false` on purpose: telling someone the watcher recovered from an outage
 * they were never told about is pure noise, and it trains them to ignore the channel that
 * matters.
 */
export async function recordSuccess(
  kv: KVStore,
  adapter: AdapterName,
  now: number,
): Promise<SuccessResult> {
  const previous = await readHealth(kv);
  const stale =
    previous === null ||
    previous.lastSuccessAt === null ||
    now - previous.lastSuccessAt >= HEALTH_REFRESH_MS;
  const recovered = previous !== null && previous.consecutiveFailures !== 0;
  const adapterChanged = previous !== null && previous.lastAdapter !== adapter;
  // `?? null`: records written before `lastPagedAt` existed simply do not have the field.
  const recoveryNoticeDue = (previous?.lastPagedAt ?? null) !== null;

  // Same `?? null` treatment: this field postdates the first deployed health records.
  const lastHeartbeatAt = previous?.lastHeartbeatAt ?? null;
  // A null value starts the clock rather than firing: a heartbeat on the first pass after every
  // deploy would be noise, and setup already proves the chain via `simulate-restock`.
  const heartbeatDue =
    lastHeartbeatAt !== null && now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS;

  // No extra writes in the steady state: `recoveryNoticeDue` can only be true when an outage
  // just ended, `recovered` is already true in that case, and `heartbeatDue` is true at most
  // once a week.
  if (
    previous !== null &&
    !stale &&
    !recovered &&
    !adapterChanged &&
    !recoveryNoticeDue &&
    !heartbeatDue
  ) {
    return { wrote: false, recoveryNoticeDue: false, heartbeatDue: false };
  }

  const next: HealthState = {
    lastSuccessAt: now,
    consecutiveFailures: 0,
    lastAdapter: adapter,
    lastReason: null,
    lastPagedAt: null,
    // Advanced only when one is actually due. Carrying the old value forward on every other
    // write is what stops the heartbeat re-firing on the very next pass.
    // Advanced when one fires, and seeded when there is none yet so the week starts counting.
    lastHeartbeatAt: heartbeatDue || lastHeartbeatAt === null ? now : lastHeartbeatAt,
  };
  await putJson(kv, KV_KEYS.health, next);
  return { wrote: true, recoveryNoticeDue, heartbeatDue };
}

export interface FailureResult {
  consecutiveFailures: number;
  /** Whether KV was actually touched. */
  wrote: boolean;
  /**
   * True when the caller should send a `detector-down` push for this pass. Already
   * rate-limited by `DETECTOR_PAGE_COOLDOWN_MS`, so the caller never needs to decide.
   */
  pageDue: boolean;
}

/**
 * Record a failed pass. Increments `consecutiveFailures` and touches NOTHING else -- no variant
 * state, no snapshot cache (invariant 1).
 *
 * The counter has to keep climbing for `FAILURE_ALERT_THRESHOLD` to be reachable, but a
 * multi-hour outage at one write per minute would blow the daily budget. So every failure is
 * written up to the threshold, and past it only once an hour (every 60th pass) -- enough to keep
 * `/status` roughly honest at ~24 writes/day during a sustained outage.
 *
 * Paging is decided here rather than in `runPass` because the decision needs `lastPagedAt`, which
 * only this function reads and writes -- and because persisting the page and deciding to send it
 * must not drift apart. A page is a state change and therefore worth a write, but it is capped at
 * one per `DETECTOR_PAGE_COOLDOWN_MS` (4/day at the current 6h), so it cannot move the budget.
 */
export async function recordFailure(
  kv: KVStore,
  reason: string,
  now: number,
): Promise<FailureResult> {
  const previous = await readHealth(kv);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  // `?? null`: records written before `lastPagedAt` existed simply do not have the field.
  const lastPagedAt = previous?.lastPagedAt ?? null;
  const pageDue =
    consecutiveFailures >= FAILURE_ALERT_THRESHOLD &&
    (lastPagedAt === null || now - lastPagedAt >= DETECTOR_PAGE_COOLDOWN_MS);

  const shouldWrite =
    pageDue || consecutiveFailures <= FAILURE_ALERT_THRESHOLD || consecutiveFailures % 60 === 0;
  if (!shouldWrite) return { consecutiveFailures, wrote: false, pageDue: false };

  const next: HealthState = {
    // A failure never advances `lastSuccessAt`; `now` is only used to time the page.
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    consecutiveFailures,
    lastAdapter: previous?.lastAdapter ?? null,
    lastReason: reason.slice(0, 500),
    lastPagedAt: pageDue ? now : lastPagedAt,
    // Carried forward, never reset: an outage must not schedule a heartbeat for the moment the
    // store becomes readable again.
    lastHeartbeatAt: previous?.lastHeartbeatAt ?? null,
  };
  await putJson(kv, KV_KEYS.health, next);
  return { consecutiveFailures, wrote: true, pageDue };
}

export interface SnapshotCache {
  snapshots: StockSnapshot[];
  updatedAt: number;
}

export async function readSnapshotCache(kv: KVStore): Promise<SnapshotCache | null> {
  return getJson<SnapshotCache>(kv, SNAPSHOT_CACHE_KEY);
}

/**
 * Persist the snapshot set for `/status`, but only when it differs in a way a human would care
 * about. `checkedAt` moves every pass and is deliberately excluded from the comparison.
 */
export async function cacheSnapshots(
  kv: KVStore,
  snapshots: StockSnapshot[],
  now: number,
): Promise<boolean> {
  const previous = await readSnapshotCache(kv);
  if (previous !== null && materialKey(previous.snapshots) === materialKey(snapshots)) return false;
  const next: SnapshotCache = { snapshots, updatedAt: now };
  await putJson(kv, SNAPSHOT_CACHE_KEY, next);
  return true;
}

function materialKey(snapshots: StockSnapshot[]): string {
  return snapshots
    .map((s) => `${s.variantId}|${s.title}|${s.available}|${s.priceCents}|${s.currency}`)
    .sort()
    .join('||');
}
