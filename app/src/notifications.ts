import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { ANDROID_CHANNEL_DETECTOR, ANDROID_CHANNEL_RESTOCK } from '@astra/contract';
import type { RestockPushData } from '@astra/contract';

/**
 * Foreground display behavior. This app has nothing to poll for and nothing to compute on
 * receipt — a restock push should just show, every time, immediately.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Channel ids come from the contract, not from a local literal. The worker names the channel
 * in the outgoing push, and if the two sides disagree Android does not error — it quietly
 * delivers on a fallback channel and drops the importance and sound configured below.
 */
export async function ensureAndroidChannelAsync(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_RESTOCK, {
    name: 'Restock alerts',
    description: 'The tablet just became purchasable. Time-critical.',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#4da3ff',
  });
  // Separate channel so the plumbing can be muted without muting the thing you actually
  // care about. Lower importance: knowing the watcher broke is useful, not urgent.
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_DETECTOR, {
    name: 'Watcher health',
    description: 'The watcher lost sight of the store, so silence no longer means "sold out".',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default',
    lightColor: '#f0b429',
  });
}

export type PermissionState = 'granted' | 'denied' | 'undetermined';

function toPermissionState(
  status: Notifications.NotificationPermissionsStatus,
): PermissionState {
  if (status.granted) return 'granted';
  // `canAskAgain: false` is the reliable signal for "permanently denied" on both platforms —
  // once it flips false, only the Settings app can change it, which is exactly the case the
  // UI needs to detect and route to `Linking.openSettings()`.
  if (!status.canAskAgain) return 'denied';
  return 'undetermined';
}

export async function getPermissionStateAsync(): Promise<PermissionState> {
  const status = await Notifications.getPermissionsAsync();
  return toPermissionState(status);
}

export async function requestPermissionAsync(): Promise<PermissionState> {
  const status = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return toPermissionState(status);
}

export type PushTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not-a-device' | 'permission-denied' | 'error'; message: string };

/**
 * Acquires an Expo push token. Push tokens are meaningless on a simulator/emulator — there is
 * no APNs/FCM registration to back them — so that case is detected and reported explicitly
 * rather than let a bogus token flow into `/register` and fail silently server-side.
 */
export async function getExpoPushTokenAsync(): Promise<PushTokenResult> {
  if (!Device.isDevice) {
    return {
      ok: false,
      reason: 'not-a-device',
      message: 'Push tokens do not work on a simulator/emulator. Run this on a physical device.',
    };
  }

  const permissionState = await getPermissionStateAsync();
  if (permissionState !== 'granted') {
    return {
      ok: false,
      reason: 'permission-denied',
      message: 'Notification permission has not been granted.',
    };
  }

  try {
    await ensureAndroidChannelAsync();
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return { ok: true, token: token.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'error', message };
  }
}

function isRestockPushData(data: unknown): data is RestockPushData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.kind === 'restock' && typeof d.variantId === 'string' && typeof d.url === 'string';
}

/**
 * Fires when the user taps a notification (cold start, background, or foreground). Extracts
 * and validates `RestockPushData` so the caller only ever deals with the typed shape.
 */
export function addRestockTapListener(onTap: (data: RestockPushData) => void) {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data: unknown = response.notification.request.content.data;
    if (isRestockPushData(data)) onTap(data);
  });
}

/** Covers the case where the app was launched *by* tapping a notification (cold start). */
export function getLastRestockTap(): RestockPushData | null {
  const response = Notifications.getLastNotificationResponse();
  const data: unknown = response?.notification.request.content.data;
  return isRestockPushData(data) ? data : null;
}
