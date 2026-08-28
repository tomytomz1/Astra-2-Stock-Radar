/**
 * The `app/eas.json` transformation `pnpm bootstrap` applies after deploying the Worker.
 *
 * Split out of `bootstrap.ts` for one reason: that file calls `main()` at module scope, so
 * importing it to test anything runs the entire auth-gated setup flow. Keeping this pure and
 * importable is what lets the behaviour be verified by execution rather than by reading it --
 * which matters here, because the bug this replaced was invisible to every existing gate.
 */

/** The env var every build profile uses to find the deployed Worker. */
export const WORKER_URL_ENV = 'EXPO_PUBLIC_WORKER_URL';

/** Placeholder shipped in the committed `app/eas.json`; also rejected at runtime by app/src/api.ts. */
export const WORKER_URL_PLACEHOLDER = 'https://REPLACE-WITH-YOUR-WORKER.workers.dev';

export interface EasBuildProfile {
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface EasJson {
  /**
   * Profile name -> profile. Deliberately open: `development`, `preview`, `production` and any
   * profile added later are all treated identically.
   */
  build?: Record<string, EasBuildProfile | undefined>;
  [key: string]: unknown;
}

/** Profiles declaring `WORKER_URL_ENV`, in file order. */
export function profilesWithWorkerUrl(parsed: EasJson): Array<[string, EasBuildProfile]> {
  return Object.entries(parsed.build ?? {}).filter(
    (entry): entry is [string, EasBuildProfile] =>
      entry[1] !== undefined && entry[1].env !== undefined && WORKER_URL_ENV in entry[1].env,
  );
}

/**
 * Set the worker URL on EVERY profile that declares it, mutating `parsed` in place. Returns the
 * names of the profiles that actually changed, so a re-run reports nothing and writes nothing.
 *
 * This used to patch `build.preview` alone, leaving `production` (and `development`) on the
 * placeholder. A production build then installed, opened, rendered its UI perfectly, failed to
 * register, and never alerted -- the exact silent failure this project exists to prevent, sitting
 * in its own setup script.
 *
 * Only profiles that ALREADY declare the key are touched: one omitting it has done so on purpose,
 * and inventing an env var for it would be the setup script overreaching.
 */
export function applyWorkerUrl(parsed: EasJson, workerUrl: string): string[] {
  const changed: string[] = [];
  for (const [name, profile] of profilesWithWorkerUrl(parsed)) {
    if (profile.env?.[WORKER_URL_ENV] === workerUrl) continue;
    profile.env = { ...profile.env, [WORKER_URL_ENV]: workerUrl };
    changed.push(name);
  }
  return changed;
}
