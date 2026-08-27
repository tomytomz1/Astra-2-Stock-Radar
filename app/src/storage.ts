import AsyncStorage from '@react-native-async-storage/async-storage';

import type { VariantId } from '@astra/contract';

/**
 * Local persistence for the user's variant selection, so the picker survives an app restart
 * without waiting on a network round trip. The worker's registry (keyed by push token) remains
 * the source of truth for what actually receives alerts — this is just a UI convenience cache.
 */
const SELECTED_VARIANTS_KEY = 'astra-radar:selected-variant-ids';

/** Empty array means "alert on every variant" (matches `RegisterBody.variantIds` semantics). */
export async function loadSelectedVariantIds(): Promise<VariantId[]> {
  try {
    const raw = await AsyncStorage.getItem(SELECTED_VARIANTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is VariantId => typeof v === 'string');
  } catch {
    return [];
  }
}

export async function saveSelectedVariantIds(variantIds: VariantId[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SELECTED_VARIANTS_KEY, JSON.stringify(variantIds));
  } catch {
    // Best-effort cache; losing it only means the picker resets to "all variants" next launch.
  }
}

const PUSH_TOKEN_KEY = 'astra-radar:last-registered-token';

/** Last token this device successfully registered with the worker, to detect token rotation. */
export async function loadLastRegisteredToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PUSH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveLastRegisteredToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
  } catch {
    // Non-fatal: worst case we re-register unnecessarily on next foreground, which is harmless.
  }
}
