import { useCallback, useEffect, useState } from 'react';

import type { VariantId } from '@astra/contract';

import { loadSelectedVariantIds, saveSelectedVariantIds } from '../storage';

export interface VariantSelectionState {
  /** Empty means "all variants" — matches `RegisterBody.variantIds` semantics exactly. */
  selectedVariantIds: VariantId[];
  loaded: boolean;
  isSelected: (id: VariantId) => boolean;
  toggle: (id: VariantId) => void;
  selectAll: () => void;
}

export function useVariantSelection(): VariantSelectionState {
  const [selectedVariantIds, setSelectedVariantIds] = useState<VariantId[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      const stored = await loadSelectedVariantIds();
      setSelectedVariantIds(stored);
      setLoaded(true);
    })();
  }, []);

  const toggle = useCallback((id: VariantId) => {
    setSelectedVariantIds((prev) => {
      const next = prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id];
      void saveSelectedVariantIds(next);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedVariantIds([]);
    void saveSelectedVariantIds([]);
  }, []);

  const isSelected = useCallback(
    (id: VariantId) => selectedVariantIds.length === 0 || selectedVariantIds.includes(id),
    [selectedVariantIds],
  );

  return { selectedVariantIds, loaded, isSelected, toggle, selectAll };
}
