import { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native';

import { usePushSetup } from './src/hooks/usePushSetup';
import { useStatus } from './src/hooks/useStatus';
import { useVariantSelection } from './src/hooks/useVariantSelection';
import { addRestockTapListener, getLastRestockTap } from './src/notifications';
import { openVariant } from './src/openVariant';
import { StatusScreen } from './src/screens/StatusScreen';
import { VariantPickerSheet } from './src/screens/VariantPickerSheet';
import { colors } from './src/theme';

export default function App() {
  const status = useStatus();
  const selection = useVariantSelection();
  const push = usePushSetup(selection.selectedVariantIds);
  const [pickerVisible, setPickerVisible] = useState(false);

  // Tapping a restock notification opens the store page for that variant, whether the app was in
  // the foreground, background, or launched cold by the tap.
  //
  // Routed through `openVariant` so it lands on the SAME url a row tap does -- the push carries
  // the bare product url, which arrives with the store's default configuration selected rather
  // than the one the alert was about. The comment here used to claim this opened the variant
  // page; now it does.
  useEffect(() => {
    const lastTap = getLastRestockTap();
    if (lastTap) openVariant(lastTap.variantId, lastTap.url);

    const subscription = addRestockTapListener((data) => {
      openVariant(data.variantId, data.url);
    });
    return () => subscription.remove();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <StatusScreen
        status={status}
        push={push}
        selection={selection}
        onOpenPicker={() => setPickerVisible(true)}
      />
      <VariantPickerSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        snapshots={status.status?.snapshots ?? []}
        selectedVariantIds={selection.selectedVariantIds}
        isSelected={selection.isSelected}
        onToggle={selection.toggle}
        onSelectAll={selection.selectAll}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
