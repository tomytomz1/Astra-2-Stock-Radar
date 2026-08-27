import { ANDROID_CHANNEL_RESTOCK } from '@astra/contract';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The worker base URL is never hardcoded. It must be supplied at build/start time via
 * `EXPO_PUBLIC_WORKER_URL` (e.g. `EXPO_PUBLIC_WORKER_URL=https://astra-radar.example.workers.dev
 * expo start`). It is surfaced to the JS runtime through `extra.workerUrl`, read back out by
 * `src/api.ts` via `expo-constants`.
 */
const workerUrl = process.env.EXPO_PUBLIC_WORKER_URL ?? null;

export default ({ config }: ConfigContext): ExpoConfig => ({
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
       * here. `eas init` writes it into `app.json` for a static config, but this project uses a
       * dynamic config (`app.config.ts`), which the EAS CLI cannot edit — it prints the id and
       * expects you to wire it yourself. Both routes are honoured: the spread above picks up an
       * `app.json` if `eas init` creates one, and `EAS_PROJECT_ID` works when it doesn't.
       *
       * Left undefined, push registration fails with an unhelpful error rather than crashing —
       * `notifications.ts` only passes the option when it is set.
       */
      projectId: process.env.EAS_PROJECT_ID ?? config.extra?.eas?.projectId,
    },
  },
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
});
