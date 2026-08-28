import { describe, expect, it } from 'vitest';
import { PRODUCT_URL, productUrlForVariant } from '@astra/contract';

/**
 * The deep link both the notification tap and a status-screen row tap resolve to.
 *
 * It exists because the push carries the bare product url, which opens on the store's DEFAULT
 * configuration rather than the one the alert was about — costing taps, and risking the wrong
 * purchase, in exactly the sixty seconds this system exists for.
 */

describe('productUrlForVariant', () => {
  it('appends the variant so the store preselects that configuration', () => {
    expect(productUrlForVariant(PRODUCT_URL, '55811529474121')).toBe(
      `${PRODUCT_URL}?variant=55811529474121`,
    );
  });

  it('uses & when the url already carries a query string', () => {
    expect(productUrlForVariant('https://example.com/p?ref=email', '123')).toBe(
      'https://example.com/p?ref=email&variant=123',
    );
  });

  it('escapes an id that is not a bare number', () => {
    // The `heuristic` adapter invents slugs rather than reading real ids. It must not be able to
    // produce a url that breaks out of the query parameter.
    expect(productUrlForVariant('https://example.com/p', 'astra2 silver/16&512')).toBe(
      'https://example.com/p?variant=astra2%20silver%2F16%26512',
    );
  });

  it('returns the bare product url for an empty id rather than a dangling parameter', () => {
    expect(productUrlForVariant(PRODUCT_URL, '')).toBe(PRODUCT_URL);
    expect(productUrlForVariant(PRODUCT_URL, '   ')).toBe(PRODUCT_URL);
  });

  it('is safe to hand any id: an unknown one degrades to the default variant, not an error', () => {
    // Nothing validates the id against the store. The contract with Shopify is that an
    // unrecognised `?variant=` is ignored, landing on the same page the bare url would have.
    const url = productUrlForVariant(PRODUCT_URL, '44892134567001');
    expect(url.startsWith(PRODUCT_URL)).toBe(true);
    expect(() => new URL(url)).not.toThrow();
  });
});
