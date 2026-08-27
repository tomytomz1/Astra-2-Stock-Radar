import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';
import type { RegistrationStatus } from '../hooks/usePushSetup';

interface Props {
  status: RegistrationStatus;
  error: string | null;
  onRetry: () => void;
}

/**
 * A dropped `/register` call is a missed alert, so "not registered" must be as visible as the
 * permission-denied case, not a toast that disappears. Only renders when there's something the
 * user needs to know or do; a healthy registration is silent (shown instead as the small
 * indicator elsewhere).
 */
export function RegistrationBanner({ status, error, onRetry }: Props) {
  if (status === 'failed') {
    return (
      <View style={[styles.banner, styles.danger]}>
        <Text style={styles.title}>Not registered with the server</Text>
        <Text style={styles.body}>
          This device is not subscribed for alerts yet{error ? `: ${error}` : '.'}
        </Text>
        <Pressable style={styles.button} onPress={onRetry}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return null;
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
    backgroundColor: colors.bad,
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
