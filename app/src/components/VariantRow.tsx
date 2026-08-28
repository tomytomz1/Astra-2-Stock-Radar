import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { StockSnapshot } from '@astra/contract';

import { formatPrice } from '../relativeTime';
import { colors, spacing } from '../theme';

interface Props {
  snapshot: StockSnapshot;
  /** Whether this variant is in the user's alert selection. */
  watching: boolean;
  /** When set, the row becomes a checkbox toggle (used by the variant picker sheet). */
  onToggle?: () => void;
  /**
   * When set (and `onToggle` is not), tapping the row opens the store page for this variant.
   *
   * Every row is tappable, not just in-stock ones: the whole point is being able to act the
   * instant a badge flips, and a row that only becomes tappable at that moment is a control
   * nobody has ever practised using.
   */
  onPress?: () => void;
}

export function VariantRow({ snapshot, watching, onToggle, onPress }: Props) {
  const price = formatPrice(snapshot.priceCents, snapshot.currency);
  const content = (
    <View style={styles.row}>
      {onToggle ? (
        <View style={[styles.checkbox, watching && styles.checkboxChecked]}>
          {watching ? <Text style={styles.checkboxMark}>✓</Text> : null}
        </View>
      ) : null}

      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>
          {snapshot.title}
        </Text>
        {price ? <Text style={styles.price}>{price}</Text> : null}
      </View>

      <View style={styles.right}>
        {!onToggle && watching ? <View style={styles.watchingDot} /> : null}
        <View style={[styles.badge, snapshot.available ? styles.badgeGood : styles.badgeBad]}>
          <Text
            style={[styles.badgeText, { color: snapshot.available ? colors.good : colors.bad }]}
          >
            {snapshot.available ? 'In stock' : 'Out of stock'}
          </Text>
        </View>
        {!onToggle && onPress ? <Text style={styles.chevron}>›</Text> : null}
      </View>
    </View>
  );

  // `onToggle` wins: in the picker sheet a tap must select, never navigate away mid-selection.
  const handler = onToggle ?? onPress;
  if (handler) {
    return (
      <Pressable
        onPress={handler}
        accessibilityRole="button"
        accessibilityLabel={
          onToggle
            ? `${watching ? 'Stop watching' : 'Watch'} ${snapshot.title}`
            : `Open ${snapshot.title} on the store`
        }
        style={({ pressed }) => pressed && styles.pressed}
      >
        {content}
      </Pressable>
    );
  }
  return content;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  pressed: {
    opacity: 0.6,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  checkboxMark: {
    color: '#08131f',
    fontSize: 14,
    fontWeight: '900',
  },
  info: {
    flex: 1,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  price: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 22,
    marginLeft: 2,
    marginTop: -2,
  },
  watchingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  badge: {
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
  },
  badgeGood: {
    backgroundColor: 'rgba(62, 207, 142, 0.16)',
  },
  badgeBad: {
    backgroundColor: 'rgba(255, 92, 92, 0.12)',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textPrimary,
  },
});
