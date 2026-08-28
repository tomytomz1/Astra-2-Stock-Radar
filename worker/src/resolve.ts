import type {
  CanonicalVariantId,
  ScopedExternalId,
  SourceId,
  VariantId,
} from '@astra/contract';
import { findCanonical, findSource, type SourceDefinition } from './catalog';

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
 * Outcome of resolving an identifier a subscriber stored before canonical identity existed.
 *
 * `ambiguous` is kept distinct from `unknown` because they mean different things operationally: an
 * unknown value is stale or mistyped, while an ambiguous one means the alias table itself is
 * unsound for legacy lookups and needs a human. Both are non-matching; only the telemetry differs.
 */
export type LegacyResolution =
  | { kind: 'canonical'; canonicalId: CanonicalVariantId }
  | { kind: 'unknown' }
  | { kind: 'ambiguous'; candidates: CanonicalVariantId[] };

/**
 * Resolve a stored subscription identifier, which carries NO namespace.
 *
 * A registration written before Phase 1A holds a bare external id -- we know the value but not
 * which identity namespace it came from. So this is the one place a raw value must be matched
 * across namespaces, and it is therefore the one place ambiguity can arise.
 *
 * It must never be settled by array order. An earlier version of this function used `.find()`,
 * which silently picked whichever alias happened to be declared first -- the exact ordinal
 * reasoning banned for the alias table, reintroduced two files later. It was safe only by accident
 * because today's eight REDMAGIC values are all distinct; a second retailer sharing a GTIN, or any
 * value appearing in two namespaces, would have made it resolve by luck.
 *
 * Rule: collect every alias whose raw value matches, reduce to the DISTINCT canonicals they name.
 * Exactly one distinct canonical resolves -- several namespaces agreeing is not ambiguity. Two or
 * more distinct canonicals is genuine ambiguity and resolves to nothing.
 *
 * Callers must treat every non-`canonical` outcome as matching NO variant. It must never widen to
 * "all variants": an EMPTY subscription list means all, an unresolvable entry means none.
 */
export function resolveSubscriptionId(sourceId: SourceId, stored: string): LegacyResolution {
  if (findCanonical(stored) !== null) return { kind: 'canonical', canonicalId: stored };

  const source = findSource(sourceId);
  if (source === null) return { kind: 'unknown' };

  const distinct = [
    ...new Set(source.aliases.filter((a) => a.externalId === stored).map((a) => a.canonicalId)),
  ];
  if (distinct.length === 0) return { kind: 'unknown' };
  if (distinct.length === 1) return { kind: 'canonical', canonicalId: distinct[0] as string };
  return { kind: 'ambiguous', candidates: distinct };
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
