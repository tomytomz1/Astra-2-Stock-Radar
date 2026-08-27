import { useEffect, useState } from 'react';
import { Linking, SafeAreaView, StatusBar, StyleSheet } from 'react-native';

import { usePushSetup } from './src/hooks/usePushSetup';
import { useStatus } from './src/hooks/useStatus';
import { useVariantSelection } from './src/hooks/useVariantSelection';
import { addRestockTapListener, getLastRestockTap } from './src/notifications';
import { StatusScreen } from './src/screens/StatusScreen';
import { VariantPickerSheet } from './src/screens/VariantPickerSheet';
import { colors } from './src/theme';

export default function App() {
  const status = useStatus();
  const selection = useVariantSelection();
  const push = usePushSetup(selection.selectedVariantIds);
  const [pickerVisible, setPickerVisible] = useState(false);

  // Tapping a restock notification opens the product page for that variant, whether the app
  // was in the foreground, background, or launched cold by the tap.
  useEffect(() => {
    const lastTap = getLastRestockTap();
    if (lastTap) void Linking.openURL(lastTap.url);

    const subscription = addRestockTapListener((data) => {
      void Linking.openURL(data.url);
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
