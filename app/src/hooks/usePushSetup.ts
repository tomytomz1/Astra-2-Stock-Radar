import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Device from 'expo-device';

import type { VariantId } from '@astra/contract';

import { registerDeviceWithRetry } from '../api';
import {
  getExpoPushTokenAsync,
  getPermissionStateAsync,
  requestPermissionAsync,
  type PermissionState,
} from '../notifications';
import { saveLastRegisteredToken } from '../storage';

export type RegistrationStatus = 'idle' | 'registering' | 'registered' | 'failed';

export interface PushSetupState {
  /** `undetermined` until the first permission check resolves. */
  permissionState: PermissionState | 'checking';
  isPhysicalDevice: boolean;
  registrationStatus: RegistrationStatus;
  registrationError: string | null;
  requestPermission: () => Promise<void>;
  retryRegistration: () => Promise<void>;
}

function currentPlatform(): 'ios' | 'android' | null {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
  return null;
}

/**
 * Owns the full permission -> token -> register lifecycle. Registration is re-attempted
 * whenever the app returns to the foreground (self-heal after a dropped request, or after the
 * user grants permission from Settings) and whenever the selected variant list changes
 * (`/register` is idempotent, so redundant calls are harmless).
 */
export function usePushSetup(selectedVariantIds: VariantId[]): PushSetupState {
  const [permissionState, setPermissionState] = useState<PermissionState | 'checking'>(
    'checking',
  );
  const [registrationStatus, setRegistrationStatus] = useState<RegistrationStatus>('idle');
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  // Avoids two overlapping registration attempts (e.g. a foreground event firing mid-retry).
  const inFlight = useRef(false);
  const variantIdsRef = useRef(selectedVariantIds);
  variantIdsRef.current = selectedVariantIds;

  const attemptRegister = useCallback(async () => {
    if (inFlight.current) return;
    const platform = currentPlatform();
    if (!platform || !Device.isDevice) return;

    const permission = await getPermissionStateAsync();
    setPermissionState(permission);
    if (permission !== 'granted') return;

    inFlight.current = true;
    setRegistrationStatus('registering');
    setRegistrationError(null);
    try {
      const tokenResult = await getExpoPushTokenAsync();
      if (!tokenResult.ok) {
        setRegistrationStatus('failed');
        setRegistrationError(tokenResult.message);
        return;
      }

      const result = await registerDeviceWithRetry({
        token: tokenResult.token,
        variantIds: variantIdsRef.current,
        platform,
      });

      if (result.ok) {
        await saveLastRegisteredToken(tokenResult.token);
        setRegistrationStatus('registered');
      } else {
        setRegistrationStatus('failed');
        setRegistrationError(result.error ?? 'Registration failed for an unknown reason.');
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  const requestPermission = useCallback(async () => {
    const next = await requestPermissionAsync();
    setPermissionState(next);
    if (next === 'granted') await attemptRegister();
  }, [attemptRegister]);

  const retryRegistration = useCallback(async () => {
    await attemptRegister();
  }, [attemptRegister]);

  // Initial check on mount.
  useEffect(() => {
    void attemptRegister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-register whenever the variant selection changes, once already granted.
  useEffect(() => {
    if (permissionState === 'granted') void attemptRegister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVariantIds]);

  // Self-heal on foreground: catches a dropped registration, a permission grant made from
  // system Settings while backgrounded, or a rotated push token.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void attemptRegister();
    });
    return () => subscription.remove();
  }, [attemptRegister]);

  return {
    permissionState,
    isPhysicalDevice: Device.isDevice,
    registrationStatus,
    registrationError,
    requestPermission,
    retryRegistration,
  };
}
