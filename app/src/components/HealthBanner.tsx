import { StyleSheet, Text, View } from 'react-native';

import { FAILURE_ALERT_THRESHOLD } from '@astra/contract';

import { formatRelativeTime } from '../relativeTime';
import { colors, spacing } from '../theme';

interface Props {
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  adapter: string | null;
  nowMs: number;
  /** Devices the worker would notify. Zero means alerts go nowhere. */
  registeredDevices: number;
  /** Epoch ms until which the worker is deliberately not polling. Null when it is. */
  rateLimitedUntil: number | null;
  /** Why the last pass failed. Null when it succeeded. */
  lastReason: string | null;
}

/**
 * `consecutiveFailures > 0` means the worker cannot currently read the store at all — a
 * fundamentally different situation from "checked successfully, still out of stock". Collapsing
 * the two would let a broken detector masquerade as a quiet one, so this always renders
 * separately from (and above) the stock list whenever there's a failure streak.
 */
export function HealthBanner({
  lastSuccessAt,
  consecutiveFailures,
  adapter,
  nowMs,
  registeredDevices,
  rateLimitedUntil,
  lastReason,
}: Props) {
  // Being throttled is not the detector being broken: the store is reachable, it asked us to
  // knock less often, and the worker is complying. Rendering that as "struggling" would be
  // alarming and wrong, so it takes priority over the generic failure card below.
  const backingOff = rateLimitedUntil !== null && rateLimitedUntil > nowMs;
  const broken = consecutiveFailures >= FAILURE_ALERT_THRESHOLD;
  const degraded = consecutiveFailures > 0 && !backingOff;
  const noDevices = registeredDevices === 0;

  return (
    <View style={styles.row}>
      <View style={styles.lastChecked}>
        <Text style={styles.lastCheckedText}>
          {lastSuccessAt === null
            ? 'Never checked successfully'
            : `Last checked ${formatRelativeTime(lastSuccessAt, nowMs)}`}
        </Text>
        {adapter ? <Text style={styles.adapterText}>via {adapter}</Text> : null}
      </View>

      {noDevices ? (
        <View style={[styles.warningCard, styles.danger]}>
          <Text style={styles.warningTitle}>No device will be alerted</Text>
          <Text style={styles.warningBody}>
            The watcher is running, but no push token is registered — a restock would be detected
            and delivered to nobody. Pull to refresh; if this persists, grant notification
            permission in Settings.
          </Text>
        </View>
      ) : null}

      {backingOff ? (
        <View style={[styles.warningCard, styles.warning]}>
          <Text style={styles.warningTitle}>Backing off — store asked us to slow down</Text>
          <Text style={styles.warningBody}>
            The store returned "too many requests", so polling is paused until{' '}
            {formatClockTime(rateLimitedUntil)} and will resume on its own. The stock numbers below
            may be stale — this is not the same as "out of stock".
          </Text>
        </View>
      ) : null}

      {degraded ? (
        <View style={[styles.warningCard, broken ? styles.danger : styles.warning]}>
          <Text style={styles.warningTitle}>
            {broken ? 'Detector appears broken' : 'Detector is struggling'}
          </Text>
          <Text style={styles.warningBody}>
            {consecutiveFailures} consecutive failed check{consecutiveFailures === 1 ? '' : 's'}.
            The stock numbers below may be stale — this is not the same as "out of stock".
          </Text>
          {/* Naming the cause is the difference between a banner you can act on and one that
              sends you to wrangler to find out what it meant. */}
          {lastReason ? <Text style={styles.reasonText}>{truncate(lastReason)}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Local wall-clock time, e.g. "7:34 PM" — the only form that answers "how long until it retries". */
function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Reasons chain every adapter's failure together and run long; the first clause carries it. */
function truncate(reason: string): string {
  const firstClause = reason.split(' | ')[0] ?? reason;
  return firstClause.length > 120 ? `${firstClause.slice(0, 119)}…` : firstClause;
}

const styles = StyleSheet.create({
  row: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  lastChecked: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  lastCheckedText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  adapterText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  warningCard: {
    marginTop: spacing.sm,
    borderRadius: 12,
    borderWidth: 1,
    padding: spacing.md,
  },
  warning: {
    backgroundColor: '#3a2c10',
    borderColor: colors.warning,
  },
  danger: {
    backgroundColor: '#3a1414',
    borderColor: colors.bad,
  },
  warningTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  warningBody: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  reasonText: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 6,
    opacity: 0.75,
    fontVariant: ['tabular-nums'],
  },
});
