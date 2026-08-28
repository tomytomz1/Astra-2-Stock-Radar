import { useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { PRODUCT_TITLE } from '@astra/contract';
import type { StockSnapshot } from '@astra/contract';

import { HealthBanner } from '../components/HealthBanner';
import { PermissionBanner } from '../components/PermissionBanner';
import { RegistrationBanner } from '../components/RegistrationBanner';
import { VariantRow } from '../components/VariantRow';
import { openVariant } from '../openVariant';
import type { PushSetupState } from '../hooks/usePushSetup';
import type { StatusState } from '../hooks/useStatus';
import type { VariantSelectionState } from '../hooks/useVariantSelection';
import { colors, spacing } from '../theme';

interface Props {
  status: StatusState;
  push: PushSetupState;
  selection: VariantSelectionState;
  onOpenPicker: () => void;
}

/** Ticks every 30s purely so "last checked Ns ago" stays fresh on screen — no network calls. */
function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

export function StatusScreen({ status, push, selection, onOpenPicker }: Props) {
  const nowMs = useNowMs();
  const snapshots: StockSnapshot[] = status.status?.snapshots ?? [];

  const registrationLabel =
    push.registrationStatus === 'registered'
      ? selection.selectedVariantIds.length === 0
        ? 'Alerting on all variants'
        : `Alerting on ${selection.selectedVariantIds.length} variant${selection.selectedVariantIds.length === 1 ? '' : 's'}`
      : push.registrationStatus === 'registering'
        ? 'Registering…'
        : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{PRODUCT_TITLE}</Text>
          {registrationLabel ? <Text style={styles.subtitle}>{registrationLabel}</Text> : null}
        </View>
        <Pressable style={styles.settingsButton} onPress={onOpenPicker} hitSlop={12}>
          <Text style={styles.settingsButtonText}>Variants</Text>
        </Pressable>
      </View>

      <PermissionBanner
        permissionState={push.permissionState}
        isPhysicalDevice={push.isPhysicalDevice}
        onRequestPermission={() => void push.requestPermission()}
      />
      <RegistrationBanner
        status={push.registrationStatus}
        error={push.registrationError}
        onRetry={() => void push.retryRegistration()}
      />

      <HealthBanner
        lastSuccessAt={status.status?.lastSuccessAt ?? null}
        consecutiveFailures={status.status?.consecutiveFailures ?? 0}
        adapter={status.status?.adapter ?? null}
        nowMs={nowMs}
        // Defaults to 1, not 0: before the first /status response we simply do not know, and
        // claiming "no device will be alerted" on a loading screen would be a false alarm.
        registeredDevices={status.status?.registeredDevices ?? 1}
        rateLimitedUntil={status.status?.rateLimitedUntil ?? null}
        lastReason={status.status?.lastReason ?? null}
      />

      {status.error ? (
        <View style={styles.fetchErrorRow}>
          <Text style={styles.fetchErrorText}>Couldn't load status: {status.error}</Text>
        </View>
      ) : null}

      <FlatList
        data={snapshots}
        keyExtractor={(item: StockSnapshot) => item.variantId}
        renderItem={({ item }) => (
          <VariantRow
            snapshot={item}
            watching={selection.isSelected(item.variantId)}
            onPress={() => openVariant(item.variantId)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={status.refreshing}
            onRefresh={() => void status.refresh()}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          status.loading ? null : (
            <Text style={styles.emptyText}>
              No stock data yet. Pull down to refresh.
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
  },
  headerText: {
    flex: 1,
    paddingRight: spacing.sm,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  settingsButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  settingsButtonText: {
    color: colors.accent,
    fontWeight: '600',
    fontSize: 13,
  },
  fetchErrorRow: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  fetchErrorText: {
    color: colors.bad,
    fontSize: 12,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },
  listContent: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    flexGrow: 1,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});
