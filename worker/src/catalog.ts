import { REDMAGIC_SOURCE_ID } from '@astra/contract';
import type {
  CanonicalVariant,
  CanonicalVariantId,
  IdentityNamespace,
  SourceId,
} from '@astra/contract';

/**
 * Astra2Radar's variant catalogue and the alias tables that map source identifiers onto it.
 *
 * WHY THIS FILE EXISTS
 *
 * Production accumulated NINE `state:variant:*` keys for FOUR physical tablets: four Shopify
 * variant ids, four SKU values, and one test-fixture id. Nothing in the system knew any of them
 * referred to the same products, so a fallback from `shopify-js` to `jsonld` would have made every
 * variant look newly discovered. Identity now belongs to us; the store's identifiers are aliases.
 *
 * RULE, LEARNED THE HARD WAY: an alias is only ever established from a source record that pairs
 * the identifier with the variant in the same object. Ordering, numeric proximity and position are
 * NOT evidence. An earlier draft of this table paired the ids by ascending order and got two of
 * four wrong -- `…2428` and `…2459` are transposed relative to their Shopify ids -- which would
 * have cross-wired Eclipse 16+512 and Starfrost 12+256 subscriptions.
 */

export const CATALOG: readonly CanonicalVariant[] = [
  {
    id: 'astra2-eclipse-12-256',
    productId: 'astra2',
    colour: 'eclipse',
    ramGb: 12,
    storageGb: 256,
    displayName: 'Eclipse / 12GB + 256GB',
  },
  {
    id: 'astra2-eclipse-16-512',
    productId: 'astra2',
    colour: 'eclipse',
    ramGb: 16,
    storageGb: 512,
    displayName: 'Eclipse / 16GB + 512GB',
  },
  {
    id: 'astra2-starfrost-12-256',
    productId: 'astra2',
    colour: 'starfrost',
    ramGb: 12,
    storageGb: 256,
    displayName: 'Starfrost / 12GB + 256GB',
  },
  {
    id: 'astra2-starfrost-16-512',
    productId: 'astra2',
    colour: 'starfrost',
    ramGb: 16,
    storageGb: 512,
    displayName: 'Starfrost / 16GB + 512GB',
  },
] as const;

export interface VariantAlias {
  namespace: IdentityNamespace;
  externalId: string;
  canonicalId: CanonicalVariantId;
}

export interface SourceDefinition {
  sourceId: SourceId;
  /**
   * The namespace whose identifier the storefront's cart understands. For REDMAGIC that is the
   * Shopify variant id: `?variant=<sku>` is silently ignored and shows the default variant.
   * Null means the source has no per-variant purchase link; consumers use the bare product URL.
   */
  purchaseNamespace: IdentityNamespace | null;
  /**
   * Canonical variants this source is expected to carry. Coverage is checked against THIS, not
   * against the whole catalogue: a future retailer may legitimately stock only a subset.
   */
  supportedVariants: readonly CanonicalVariantId[];
  aliases: readonly VariantAlias[];
}

/**
 * Aliases for the official REDMAGIC storefront.
 *
 * Primary evidence: the Shopify `.js` product endpoint, which returns `id` and `sku` on the same
 * variant object. Independently corroborated -- the four sku values are exactly the four
 * otherwise-unexplained `state:variant:*` keys in production, as sets.
 *
 * Only `shopify-variant-id` and `source-sku` are registered. `source-mpn` is deliberately ABSENT:
 * `jsonld.ts` falls back to an `mpn` field, but no evidence shows REDMAGIC populates it with these
 * values, and an alias must never be widened because two fields might plausibly hold the same
 * value. An observation arriving under `source-mpn` or `gtin` therefore resolves to null and is
 * fail-closed until evidence establishes the mapping.
 */
export const REDMAGIC_SOURCE: SourceDefinition = {
  sourceId: REDMAGIC_SOURCE_ID,
  purchaseNamespace: 'shopify-variant-id',
  supportedVariants: [
    'astra2-eclipse-12-256',
    'astra2-eclipse-16-512',
    'astra2-starfrost-12-256',
    'astra2-starfrost-16-512',
  ],
  aliases: [
    { namespace: 'shopify-variant-id', externalId: '55811529474121', canonicalId: 'astra2-eclipse-12-256' },
    { namespace: 'source-sku', externalId: '6978069502381', canonicalId: 'astra2-eclipse-12-256' },
    { namespace: 'shopify-variant-id', externalId: '55811529506889', canonicalId: 'astra2-eclipse-16-512' },
    { namespace: 'source-sku', externalId: '6978069502459', canonicalId: 'astra2-eclipse-16-512' },
    { namespace: 'shopify-variant-id', externalId: '55811529572425', canonicalId: 'astra2-starfrost-12-256' },
    { namespace: 'source-sku', externalId: '6978069502428', canonicalId: 'astra2-starfrost-12-256' },
    { namespace: 'shopify-variant-id', externalId: '55811529605193', canonicalId: 'astra2-starfrost-16-512' },
    { namespace: 'source-sku', externalId: '6978069502497', canonicalId: 'astra2-starfrost-16-512' },
  ],
};

export const SOURCES: readonly SourceDefinition[] = [REDMAGIC_SOURCE] as const;

export function findSource(sourceId: SourceId): SourceDefinition | null {
  return SOURCES.find((s) => s.sourceId === sourceId) ?? null;
}

export function findCanonical(id: CanonicalVariantId): CanonicalVariant | null {
  return CATALOG.find((v) => v.id === id) ?? null;
}
