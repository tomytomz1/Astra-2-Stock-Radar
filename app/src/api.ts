import Constants from 'expo-constants';

import type { RegisterBody, StatusResponse, UnregisterBody } from '@astra/contract';

/**
 * Thin client for the worker's HTTP API. The worker is the only thing that ever knows about
 * stock state — this module just moves `RegisterBody` / `UnregisterBody` / `StatusResponse`
 * across the wire, exactly as the contract defines them.
 */

export class WorkerConfigError extends Error {}
export class WorkerRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
  }
}

let cachedBaseUrl: string | undefined;

/**
 * The worker base URL, sourced from `app.config.ts` -> `extra.workerUrl`, which itself reads
 * `EXPO_PUBLIC_WORKER_URL` at config-eval time. Never hardcoded here or anywhere else.
 */
export function getWorkerBaseUrl(): string {
  if (cachedBaseUrl !== undefined) return cachedBaseUrl;

  const extra: unknown = Constants.expoConfig?.extra;
  const raw =
    extra && typeof extra === 'object' && 'workerUrl' in extra
      ? (extra as { workerUrl: unknown }).workerUrl
      : null;

  if (typeof raw !== 'string' || raw.length === 0) {
    throw new WorkerConfigError(
      'EXPO_PUBLIC_WORKER_URL is not set. Set it before running/building the app ' +
        '(e.g. `EXPO_PUBLIC_WORKER_URL=https://your-worker.workers.dev expo start`).',
    );
  }

  // The template placeholder from app/eas.json. `pnpm bootstrap` replaces it in every build
  // profile, but a build made before that ran -- or with a profile it somehow missed -- would
  // otherwise resolve DNS-fail on every request and read as "the store is down" rather than "this
  // binary was built without a worker URL". Those need completely different fixes.
  if (raw.includes('REPLACE-WITH-YOUR-WORKER')) {
    throw new WorkerConfigError(
      `This build was made with a placeholder worker URL (${raw}). Run \`pnpm bootstrap\` to write ` +
        'the deployed URL into app/eas.json, then rebuild -- an OTA update cannot fix it, because ' +
        'the URL is baked in at build time.',
    );
  }

  cachedBaseUrl = raw.replace(/\/+$/, '');
  return cachedBaseUrl;
}

const REQUEST_TIMEOUT_MS = 10_000;

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const baseUrl = getWorkerBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new WorkerRequestError(
        `${path} responded ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof WorkerRequestError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WorkerRequestError(`${path} timed out after ${REQUEST_TIMEOUT_MS}ms`, null);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new WorkerRequestError(`${path} failed: ${message}`, null);
  } finally {
    clearTimeout(timeout);
  }
}

/** `POST /register`. Idempotent on the worker side; safe to call repeatedly with the same body. */
export async function registerDevice(body: RegisterBody): Promise<void> {
  await request<void>('/register', { method: 'POST', body: JSON.stringify(body) });
}

/** `POST /unregister`. */
export async function unregisterDevice(body: UnregisterBody): Promise<void> {
  await request<void>('/unregister', { method: 'POST', body: JSON.stringify(body) });
}

/** `GET /status`. */
export async function fetchStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/status', { method: 'GET' });
}

export interface RetryResult {
  ok: boolean;
  error: string | null;
}

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * Registration must not be a fire-and-forget call: a dropped `/register` is a missed alert.
 * Retries with backoff, then reports failure so the UI can show a persistent "not registered"
 * state instead of silently leaving the device unsubscribed.
 */
export async function registerDeviceWithRetry(body: RegisterBody): Promise<RetryResult> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await registerDevice(body);
      return { ok: true, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await new Promise<void>((resolve) => setTimeout(() => resolve(), delay));
      }
    }
  }

  return { ok: false, error: lastError };
}
