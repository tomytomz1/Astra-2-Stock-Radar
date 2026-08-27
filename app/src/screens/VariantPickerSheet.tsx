import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { StockSnapshot, VariantId } from '@astra/contract';

import { VariantRow } from '../components/VariantRow';
import { colors, spacing } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  snapshots: StockSnapshot[];
  selectedVariantIds: VariantId[];
  isSelected: (id: VariantId) => boolean;
  onToggle: (id: VariantId) => void;
  onSelectAll: () => void;
}

/** Variant subscription picker. Empty selection means "alert on all variants". */
export function VariantPickerSheet({
  visible,
  onClose,
  snapshots,
  selectedVariantIds,
  isSelected,
  onToggle,
  onSelectAll,
}: Props) {
  const allSelected = selectedVariantIds.length === 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Alert me for</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>

        <Pressable style={styles.allRow} onPress={onSelectAll}>
          <View style={[styles.checkbox, allSelected && styles.checkboxChecked]}>
            {allSelected ? <Text style={styles.checkboxMark}>✓</Text> : null}
          </View>
          <Text style={styles.allRowText}>All variants</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>OR PICK SPECIFIC CONFIGURATIONS</Text>

        <FlatList
          data={snapshots}
          keyExtractor={(item) => item.variantId}
          renderItem={({ item }) => (
            <VariantRow
              snapshot={item}
              watching={!allSelected && isSelected(item.variantId)}
              onToggle={() => onToggle(item.variantId)}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No variants known yet — pull to refresh on the main screen.</Text>
          }
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
  },
  doneText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  allRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  allRowText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
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
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
    padding: spacing.md,
  },
});
