import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';
import type { PermissionState } from '../notifications';

interface Props {
  permissionState: PermissionState | 'checking';
  isPhysicalDevice: boolean;
  onRequestPermission: () => void;
}

/**
 * The permission-denied case is the one failure mode this app cannot afford to hide: if the
 * user believes they're covered and aren't, the restock comes and goes silently. So this banner
 * is loud (red, persistent, top of screen) and always actionable.
 */
export function PermissionBanner({ permissionState, isPhysicalDevice, onRequestPermission }: Props) {
  if (!isPhysicalDevice) {
    return (
      <View style={[styles.banner, styles.warning]}>
        <Text style={styles.title}>Running on a simulator</Text>
        <Text style={styles.body}>
          Push tokens don't work here. Install this on a physical iPhone or Android device to
          receive restock alerts.
        </Text>
      </View>
    );
  }

  if (permissionState === 'granted' || permissionState === 'checking') return null;

  if (permissionState === 'denied') {
    return (
      <View style={[styles.banner, styles.danger]}>
        <Text style={styles.title}>Notifications are OFF</Text>
        <Text style={styles.body}>
          You will NOT be alerted when the Astra 2 restocks. Enable notifications in Settings to
          fix this.
        </Text>
        <Pressable style={styles.button} onPress={() => Linking.openSettings()}>
          <Text style={styles.buttonText}>Open Settings</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.banner, styles.warning]}>
      <Text style={styles.title}>Notifications not enabled yet</Text>
      <Text style={styles.body}>
        Grant permission so this app can alert you the moment stock appears.
      </Text>
      <Pressable style={styles.button} onPress={onRequestPermission}>
        <Text style={styles.buttonText}>Enable Notifications</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
  },
  danger: {
    backgroundColor: '#3a1414',
    borderColor: colors.bad,
  },
  warning: {
    backgroundColor: '#3a2c10',
    borderColor: colors.warning,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  body: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  button: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
  },
  buttonText: {
    color: '#08131f',
    fontWeight: '700',
    fontSize: 14,
  },
});
