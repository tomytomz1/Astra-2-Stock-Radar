import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchInit, FetchLike, FetchResponse } from '../src/detect/types';
import type { KVStore } from '../src/kv';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

export function jsonFixture(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

/**
 * In-memory KV that COUNTS writes.
 *
 * The write counter is the whole point: invariant 3 ("no change, no write") is only really tested
 * if a test can assert `kv.writes === 0`, and `writeKeys` lets a test prove that a failed pass
 * touched the health key and nothing else.
 */
export class FakeKV implements KVStore {
  readonly store = new Map<string, string>();
  writes = 0;
  reads = 0;
  deletes = 0;
  readonly writeKeys: string[] = [];

  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.store.set(key, JSON.stringify(value));
    }
  }

  async get(key: string): Promise<string | null> {
    this.reads += 1;
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.writeKeys.push(key);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.store.delete(key);
  }

  /** Convenience for assertions. */
  read<T>(key: string): T | null {
    const raw = this.store.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  resetCounters(): void {
    this.writes = 0;
    this.reads = 0;
    this.deletes = 0;
    this.writeKeys.length = 0;
  }
}

export interface RecordedCall {
  url: string;
  init: FetchInit | undefined;
  /** Parsed JSON body when the call had one. */
  body: unknown;
}

export interface FakeFetch {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
  callsTo(urlPrefix: string): RecordedCall[];
}

export type Route = (url: string, init: FetchInit | undefined) => FetchResponse | Promise<FetchResponse>;

/** Build a `fetch` stub that records every call. No network is ever touched in these tests. */
export function fakeFetch(route: Route): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    let body: unknown;
    if (init?.body !== undefined) {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, init, body });
    return route(url, init);
  };
  return {
    fetchImpl,
    calls,
    callsTo: (urlPrefix: string) => calls.filter((call) => call.url.startsWith(urlPrefix)),
  };
}

export function textResponse(body: string, status = 200): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

export function jsonResponse(body: unknown, status = 200): FetchResponse {
  return textResponse(JSON.stringify(body), status);
}

export function errorResponse(status: number): FetchResponse {
  return {
    ok: false,
    status,
    text: async () => '',
    json: async () => {
      throw new Error(`HTTP ${status}`);
    },
  };
}

/**
 * A throttled response, optionally carrying `Retry-After`.
 *
 * Real 429s come with headers; `errorResponse` deliberately has none, so a test that wants to
 * exercise the header path has to say so explicitly.
 */
export function rateLimitedResponse(retryAfter?: string): FetchResponse {
  return {
    ok: false,
    status: 429,
    text: async () => '',
    json: async () => {
      throw new Error('HTTP 429');
    },
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' && retryAfter !== undefined ? retryAfter : null,
    },
  };
}

/** A fetch stub that fails every request — used to prove nothing was sent. */
export function throwingFetch(): FakeFetch {
  return fakeFetch(() => {
    throw new Error('network unreachable');
  });
}
