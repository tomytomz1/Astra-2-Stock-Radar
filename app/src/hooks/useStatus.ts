import { useCallback, useEffect, useState } from 'react';

import type { StatusResponse } from '@astra/contract';

import { fetchStatus } from '../api';

export interface StatusState {
  status: StatusResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetches `/status` once on mount and on demand (pull-to-refresh). Deliberately no interval —
 * the worker is what watches the store; this screen just reads its last result when the user
 * looks at it.
 */
export function useStatus(): StatusState {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await fetchStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isRefresh) setRefreshing(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { status, loading, refreshing, error, refresh };
}
