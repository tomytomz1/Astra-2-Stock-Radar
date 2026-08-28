import { Linking } from 'react-native';

import { PRODUCT_URL, productUrlForVariant } from '@astra/contract';
import type { VariantId } from '@astra/contract';

/**
 * Open the store page for one variant.
 *
 * Shared by the two ways in: tapping a notification, and tapping a row on the status screen.
 * They must land in the same place — a row tap that behaved differently from the notification
 * would be a second, subtly-wrong path through the only sixty seconds that matter.
 *
 * `Linking.openURL` rejects when no handler exists (it cannot, for https, on a real device) and
 * when the URL is malformed. Swallowed rather than crashed: failing to open a page is a
 * disappointment, an unhandled rejection at the moment of a drop is worse.
 */
export function openVariant(variantId: VariantId, productUrl: string = PRODUCT_URL): void {
  void Linking.openURL(productUrlForVariant(productUrl, variantId)).catch(() => {});
}
