import { StyleSheet, Text, View } from 'react-native';

import { FAILURE_ALERT_THRESHOLD } from '@astra/contract';

import { formatRelativeTime } from '../relativeTime';
import { colors, spacing } from '../theme';

interface Props {
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  adapter: string | null;
  nowMs: number;
}

/**
 * `consecutiveFailures > 0` means the worker cannot currently read the store at all — a
 * fundamentally different situation from "checked successfully, still out of stock". Collapsing
 * the two would let a broken detector masquerade as a quiet one, so this always renders
 * separately from (and above) the stock list whenever there's a failure streak.
 */
export function HealthBanner({ lastSuccessAt, consecutiveFailures, adapter, nowMs }: Props) {
  const broken = consecutiveFailures >= FAILURE_ALERT_THRESHOLD;
  const degraded = consecutiveFailures > 0;

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

      {degraded ? (
        <View style={[styles.warningCard, broken ? styles.danger : styles.warning]}>
          <Text style={styles.warningTitle}>
            {broken ? 'Detector appears broken' : 'Detector is struggling'}
          </Text>
          <Text style={styles.warningBody}>
            {consecutiveFailures} consecutive failed check{consecutiveFailures === 1 ? '' : 's'}.
            The stock numbers below may be stale — this is not the same as "out of stock".
          </Text>
        </View>
      ) : null}
    </View>
  );
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
});
