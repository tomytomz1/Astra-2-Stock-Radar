import { ANDROID_CHANNEL_RESTOCK } from '@astra/contract';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The worker base URL is never hardcoded. It must be supplied at build/start time via
 * `EXPO_PUBLIC_WORKER_URL` (e.g. `EXPO_PUBLIC_WORKER_URL=https://astra-radar.example.workers.dev
 * expo start`). It is surfaced to the JS runtime through `extra.workerUrl`, read back out by
 * `src/api.ts` via `expo-constants`.
 */
const workerUrl = process.env.EXPO_PUBLIC_WORKER_URL ?? null;

export default ({ config }: ConfigContext): ExpoConfig => {
  /**
   * Resolved once and reused: it identifies the project for push tokens AND for OTA updates,
   * and the two must not be allowed to disagree. `eas init` / `eas update:configure` cannot
   * write into a dynamic config, so both are wired by hand from this one value.
   */
  const easProjectId: string | undefined =
    process.env.EAS_PROJECT_ID ?? (config.extra?.eas?.projectId as string | undefined);

  return {
  ...config,
  name: 'Astra Radar',
  slug: 'astra-2-stock-radar',
  scheme: 'astra-radar',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0b0f14',
  ios: {
    ...config.ios,
    bundleIdentifier: 'gg.astraradar.app',
    supportsTablet: true,
    // No `UIBackgroundModes` entry: this app never wakes in the background. The
    // `expo-notifications` plugin below adds the `aps-environment` entitlement needed for
    // remote push automatically; no other Info.plist keys are required for foreground/tap
    // notification handling.
    infoPlist: {
      ...config.ios?.infoPlist,
    },
  },
  android: {
    ...config.android,
    package: 'gg.astraradar.app',
    adaptiveIcon: {
      backgroundColor: '#0b0f14',
    },
  },
  extra: {
    ...config.extra,
    workerUrl,
    eas: {
      ...config.extra?.eas,
      /**
       * `getExpoPushTokenAsync` needs this, and `src/notifications.ts` reads it from exactly
       * here. Left undefined, push registration fails with a clear error rather than crashing —
       * `notifications.ts` only passes the option when it is set.
       */
      projectId: easProjectId,
    },
  },
  /**
   * OTA updates. `runtimeVersion` is the safety property that makes this sane: an update only
   * reaches builds whose native code matches, so a JS bundle can never land on a binary missing
   * the native module it needs. Omitted entirely when no project id is set, because a config
   * carrying `updates.url` for a project that does not exist is worse than one carrying neither.
   */
  ...(easProjectId
    ? {
        updates: { url: `https://u.expo.dev/${easProjectId}` },
        runtimeVersion: { policy: 'appVersion' as const },
      }
    : {}),
  plugins: [
    ...(config.plugins ?? []),
    [
      'expo-notifications',
      {
        color: '#4da3ff',
        // From the contract, never a literal: the Worker names this channel in every outgoing
        // push, and Android silently downgrades importance and sound on a mismatch.
        defaultChannel: ANDROID_CHANNEL_RESTOCK,
      },
    ],
  ],
  };
};
