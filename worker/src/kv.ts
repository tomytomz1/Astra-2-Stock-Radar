/**
 * Minimal KV surface the worker actually needs.
 *
 * Declared structurally rather than importing `KVNamespace` at every call site so the tests can
 * substitute a fake that COUNTS writes. Cloudflare's `KVNamespace` satisfies this interface, so
 * `env.STOCK_KV` can be passed anywhere a `KVStore` is expected.
 */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Read and JSON-parse a key. Returns null for a missing key OR unparsable garbage. */
export async function getJson<T>(kv: KVStore, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt value is indistinguishable from an absent one for our purposes: the caller
    // re-derives state from the next observation. Never throw out of a cron pass.
    return null;
  }
}

export async function putJson(kv: KVStore, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}
