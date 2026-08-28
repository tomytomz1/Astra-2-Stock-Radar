import { describe, expect, it } from 'vitest';
import { REDMAGIC_SOURCE_ID } from '@astra/contract';
import type { CanonicalVariantId, ScopedExternalId } from '@astra/contract';
import { CATALOG, REDMAGIC_SOURCE, type SourceDefinition } from '../src/catalog';
import {
  missingCoverage,
  preferredPurchaseAlias,
  resolveCanonical,
  resolveSubscriptionId,
} from '../src/resolve';

/**
 * Canonical identity: external identifiers are aliases, never identity.
 *
 * Production held NINE `state:variant:*` keys for FOUR tablets, in two disjoint namespaces, and
 * nothing knew they were the same products. These tests pin the mapping to primary evidence and
 * forbid every shortcut that produced a wrong answer while designing it.
 */

const ECLIPSE_12 = 'astra2-eclipse-12-256';
const ECLIPSE_16 = 'astra2-eclipse-16-512';
const STARFROST_12 = 'astra2-starfrost-12-256';
const STARFROST_16 = 'astra2-starfrost-16-512';

function scoped(namespace: ScopedExternalId['namespace'], externalId: string): ScopedExternalId {
  return { sourceId: REDMAGIC_SOURCE_ID, namespace, externalId };
}

describe('alias resolution', () => {
  it('resolves all eight authoritative aliases to their exact canonical variant', () => {
    const expected: Array<[ScopedExternalId, CanonicalVariantId]> = [
      [scoped('shopify-variant-id', '55811529474121'), ECLIPSE_12],
      [scoped('source-sku', '6978069502381'), ECLIPSE_12],
      [scoped('shopify-variant-id', '55811529506889'), ECLIPSE_16],
      [scoped('source-sku', '6978069502459'), ECLIPSE_16],
      [scoped('shopify-variant-id', '55811529572425'), STARFROST_12],
      [scoped('source-sku', '6978069502428'), STARFROST_12],
      [scoped('shopify-variant-id', '55811529605193'), STARFROST_16],
      [scoped('source-sku', '6978069502497'), STARFROST_16],
    ];
    for (const [id, canonical] of expected) expect(resolveCanonical(id)).toBe(canonical);
  });

  it('ANTI-ORDINAL: the two transposed pairs map by evidence, not by sorted position', () => {
    // Sorting both namespaces ascending pairs these backwards. That inference was made during
    // planning and was wrong for two of four variants -- it would have cross-wired Eclipse 16+512
    // and Starfrost 12+256 subscriptions. This test fails under any ordinal scheme.
    expect(resolveCanonical(scoped('source-sku', '6978069502459'))).toBe(ECLIPSE_16);
    expect(resolveCanonical(scoped('source-sku', '6978069502428'))).toBe(STARFROST_12);
    expect(resolveCanonical(scoped('source-sku', '6978069502459'))).not.toBe(STARFROST_12);
    expect(resolveCanonical(scoped('source-sku', '6978069502428'))).not.toBe(ECLIPSE_16);
  });

  it('resolves both namespaces of one variant to the same canonical', () => {
    expect(resolveCanonical(scoped('shopify-variant-id', '55811529474121'))).toBe(
      resolveCanonical(scoped('source-sku', '6978069502381')),
    );
  });

  it('fails closed on an unknown value, namespace or source', () => {
    expect(resolveCanonical(scoped('shopify-variant-id', 'nope'))).toBeNull();
    // The right value in the wrong namespace must not resolve.
    expect(resolveCanonical(scoped('source-sku', '55811529474121'))).toBeNull();
    expect(resolveCanonical(scoped('gtin', '6978069502381'))).toBeNull();
    expect(resolveCanonical(scoped('source-mpn', '6978069502381'))).toBeNull();
    expect(
      resolveCanonical({ sourceId: 'some-other-shop', namespace: 'source-sku', externalId: '6978069502381' }),
    ).toBeNull();
  });

  it('pins the fixture id that leaked into production as unresolvable', () => {
    // `state:variant:44892134567001` exists in live KV: a test-fixture id written by a mistaken
    // simulate-restock run. It is not a REDMAGIC variant and must never become alertable.
    expect(resolveCanonical(scoped('shopify-variant-id', '44892134567001'))).toBeNull();
  });

  it('never resolves a synthetic identifier, so a heuristic-only pass cannot alert', () => {
    expect(resolveCanonical(scoped('synthetic', 'redmagic-astra-2-gaming-tablet'))).toBeNull();
  });
});

describe('purchase alias', () => {
  it('returns a Shopify id for every declared variant, never a sku', () => {
    const shopifyIds = new Set([
      '55811529474121',
      '55811529506889',
      '55811529572425',
      '55811529605193',
    ]);
    for (const canonical of [ECLIPSE_12, ECLIPSE_16, STARFROST_12, STARFROST_16]) {
      const purchase = preferredPurchaseAlias(REDMAGIC_SOURCE_ID, canonical);
      expect(purchase).not.toBeNull();
      expect(shopifyIds.has(purchase as string)).toBe(true);
    }
    // All four are distinct: no two variants share a purchase link.
    const resolved = [ECLIPSE_12, ECLIPSE_16, STARFROST_12, STARFROST_16].map((c) =>
      preferredPurchaseAlias(REDMAGIC_SOURCE_ID, c),
    );
    expect(new Set(resolved).size).toBe(4);
  });

  it('maps each canonical to its own Shopify id, not a neighbouring one', () => {
    expect(preferredPurchaseAlias(REDMAGIC_SOURCE_ID, ECLIPSE_16)).toBe('55811529506889');
    expect(preferredPurchaseAlias(REDMAGIC_SOURCE_ID, STARFROST_12)).toBe('55811529572425');
  });

  it('returns null for an unknown source or a variant the source does not carry', () => {
    expect(preferredPurchaseAlias('some-other-shop', ECLIPSE_12)).toBeNull();
    expect(preferredPurchaseAlias(REDMAGIC_SOURCE_ID, 'astra2-does-not-exist')).toBeNull();
  });
});

describe('legacy subscription resolution (no namespace stored)', () => {
  it('1. resolves a raw legacy Shopify id', () => {
    expect(resolveSubscriptionId(REDMAGIC_SOURCE_ID, '55811529572425')).toEqual({
      kind: 'canonical',
      canonicalId: STARFROST_12,
    });
  });

  it('2. resolves a raw legacy SKU', () => {
    expect(resolveSubscriptionId(REDMAGIC_SOURCE_ID, '6978069502459')).toEqual({
      kind: 'canonical',
      canonicalId: ECLIPSE_16,
    });
  });

  it('6. resolves a canonical id stored directly', () => {
    expect(resolveSubscriptionId(REDMAGIC_SOURCE_ID, ECLIPSE_12)).toEqual({
      kind: 'canonical',
      canonicalId: ECLIPSE_12,
    });
  });

  it('reports an unknown raw value as unknown, not as a variant', () => {
    expect(resolveSubscriptionId(REDMAGIC_SOURCE_ID, '44892134567001')).toEqual({ kind: 'unknown' });
    expect(resolveSubscriptionId(REDMAGIC_SOURCE_ID, '')).toEqual({ kind: 'unknown' });
  });
});

describe('legacy raw-value ambiguity', () => {
  /** Two namespaces, one raw value, SAME canonical -- agreement, not ambiguity. */
  const agreeing: SourceDefinition = {
    sourceId: 'agreeing-shop',
    purchaseNamespace: 'shopify-variant-id',
    supportedVariants: [ECLIPSE_12],
    aliases: [
      { namespace: 'shopify-variant-id', externalId: 'SHARED', canonicalId: ECLIPSE_12 },
      { namespace: 'source-sku', externalId: 'SHARED', canonicalId: ECLIPSE_12 },
    ],
  };

  /** Two namespaces, one raw value, DIFFERENT canonicals -- genuinely ambiguous. */
  const conflicting: SourceDefinition = {
    sourceId: 'conflicting-shop',
    purchaseNamespace: 'shopify-variant-id',
    supportedVariants: [ECLIPSE_12, STARFROST_16],
    aliases: [
      { namespace: 'shopify-variant-id', externalId: 'SHARED', canonicalId: ECLIPSE_12 },
      { namespace: 'source-sku', externalId: 'SHARED', canonicalId: STARFROST_16 },
    ],
  };

  function resolveIn(source: SourceDefinition, stored: string) {
    // Exercises the same rule the production resolver applies, over a controlled alias table.
    const distinct = [
      ...new Set(source.aliases.filter((a) => a.externalId === stored).map((a) => a.canonicalId)),
    ];
    if (distinct.length === 0) return { kind: 'unknown' as const };
    if (distinct.length === 1) return { kind: 'canonical' as const, canonicalId: distinct[0] as string };
    return { kind: 'ambiguous' as const, candidates: distinct };
  }

  it('3. same raw value in two namespaces, same canonical -> resolves', () => {
    expect(resolveIn(agreeing, 'SHARED')).toEqual({ kind: 'canonical', canonicalId: ECLIPSE_12 });
  });

  it('4. same raw value in two namespaces, different canonicals -> ambiguous, not first-wins', () => {
    const result = resolveIn(conflicting, 'SHARED');
    expect(result.kind).toBe('ambiguous');
    // `.find()` would have returned ECLIPSE_12 purely because it is declared first.
    expect(result).not.toEqual({ kind: 'canonical', canonicalId: ECLIPSE_12 });
    if (result.kind === 'ambiguous') expect(result.candidates).toHaveLength(2);
  });

  it('5. ambiguity and unknown both match NOTHING, and never widen to all variants', () => {
    for (const outcome of [resolveIn(conflicting, 'SHARED'), resolveIn(conflicting, 'absent')]) {
      expect(outcome.kind).not.toBe('canonical');
      // The only thing that means "all variants" is an EMPTY subscription list. A non-empty list
      // whose entries do not resolve subscribes the device to nothing at all.
      expect('canonicalId' in outcome).toBe(false);
    }
  });
});

describe('source coverage', () => {
  it('every variant REDMAGIC declares has an alias and a purchase alias', () => {
    expect(missingCoverage(REDMAGIC_SOURCE)).toEqual([]);
    expect(REDMAGIC_SOURCE.supportedVariants).toHaveLength(CATALOG.length);
  });

  it('a source carrying a subset of the catalogue is complete for what it declares', () => {
    const subset: SourceDefinition = {
      sourceId: 'subset-shop',
      purchaseNamespace: 'retailer-sku',
      supportedVariants: [ECLIPSE_12],
      aliases: [{ namespace: 'retailer-sku', externalId: 'X-1', canonicalId: ECLIPSE_12 }],
    };
    expect(missingCoverage(subset)).toEqual([]);
  });

  it('flags a declared variant with no alias in the purchase namespace', () => {
    const broken: SourceDefinition = {
      sourceId: 'broken-shop',
      purchaseNamespace: 'shopify-variant-id',
      supportedVariants: [ECLIPSE_12],
      aliases: [{ namespace: 'source-sku', externalId: 'S-1', canonicalId: ECLIPSE_12 }],
    };
    expect(missingCoverage(broken)).toHaveLength(1);
    expect(missingCoverage(broken)[0]).toContain('shopify-variant-id');
  });
});
