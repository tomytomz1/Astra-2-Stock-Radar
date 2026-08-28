import type {
  CanonicalVariantId,
  ScopedExternalId,
  SourceId,
  VariantId,
} from '@astra/contract';
import { findSource, type SourceDefinition } from './catalog';

/**
 * Scoped identity resolution: external identifier -> Astra2Radar canonical variant.
 *
 * Every lookup is keyed by (sourceId, namespace, externalId). Namespace is part of the key rather
 * than a hint: the same string can be a Shopify id at one source and a retailer SKU at another,
 * and two different fields at the SAME source can hold different identifier kinds.
 *
 * Resolution comes ONLY from explicit aliases. It never inspects the shape of a value, never
 * matches on ordering, and never falls back to "looks like the one next to it". Unknown
 * combinations resolve to null, which every caller treats as non-alertable.
 */

/** Unknown scope, unknown namespace, or unknown value -> null. Never a guess. */
export function resolveCanonical(scoped: ScopedExternalId): CanonicalVariantId | null {
  const source = findSource(scoped.sourceId);
  if (source === null) return null;
  const match = source.aliases.find(
    (a) => a.namespace === scoped.namespace && a.externalId === scoped.externalId,
  );
  return match?.canonicalId ?? null;
}

/**
 * The identifier this source's cart understands for a canonical variant.
 *
 * Deliberately independent of whatever namespace the observation arrived in. A `jsonld` pass
 * observes a sku; the purchase link still needs the Shopify variant id. Null when the source
 * declares no purchase namespace, or has no alias for that variant in it -- callers must then use
 * the bare product URL rather than emit a link that silently resolves to the wrong variant.
 */
export function preferredPurchaseAlias(
  sourceId: SourceId,
  canonicalId: CanonicalVariantId,
): VariantId | null {
  const source = findSource(sourceId);
  if (source === null || source.purchaseNamespace === null) return null;
  const namespace = source.purchaseNamespace;
  const match = source.aliases.find(
    (a) => a.namespace === namespace && a.canonicalId === canonicalId,
  );
  return match?.externalId ?? null;
}

/**
 * Resolve an identifier a subscriber stored, which may predate canonical identity.
 *
 * Accepts, in order: a canonical id already; then any alias of this source in any namespace. A
 * value that matches nothing returns null and MUST NOT be treated as "all variants" -- an empty
 * subscription list means all, an unresolvable entry means nothing.
 */
export function resolveSubscriptionId(
  sourceId: SourceId,
  stored: string,
  isCanonical: (id: string) => boolean,
): CanonicalVariantId | null {
  if (isCanonical(stored)) return stored;
  const source = findSource(sourceId);
  if (source === null) return null;
  const match = source.aliases.find((a) => a.externalId === stored);
  return match?.canonicalId ?? null;
}

/** Coverage is measured against what the source declares it carries, not the whole catalogue. */
export function missingCoverage(source: SourceDefinition): string[] {
  const problems: string[] = [];
  for (const canonicalId of source.supportedVariants) {
    const hasAny = source.aliases.some((a) => a.canonicalId === canonicalId);
    if (!hasAny) problems.push(`${source.sourceId}: no alias for ${canonicalId}`);
    if (source.purchaseNamespace !== null) {
      const purchaseNs = source.purchaseNamespace;
      const hasPurchase = source.aliases.some(
        (a) => a.canonicalId === canonicalId && a.namespace === purchaseNs,
      );
      if (!hasPurchase) {
        problems.push(`${source.sourceId}: no ${purchaseNs} alias for ${canonicalId}`);
      }
    }
  }
  return problems;
}
