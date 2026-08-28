/**
 * pnpm simulate-restock <variantId> [--dry-run]
 *
 * Forces a real end-to-end test of the push pipeline WITHOUT waiting for the store to actually
 * restock. Without this, the first real test of the whole system is the exact moment it matters
 * most -- the drop itself.
 *
 * WHAT THIS ACTUALLY DOES (read this before running it):
 *   It resets the alert LATCH for one variant in KV to `{available: false, lastAlertedAt: null}`.
 *   It does NOT fake live availability, and it cannot make the real store say something it isn't
 *   saying. The worker's next cron tick (within ~60s) still fetches the REAL store and compares
 *   the REAL result against this reset state. A push only fires if that real fetch reports the
 *   chosen variant as available right now.
 *
 *   So: pick a variant that IS currently purchasable on the live store -- it does not have to be
 *   the specific configuration everyone is anxiously waiting for. Any variant that is in stock
 *   right now will do; resetting its latch makes the worker treat its current (real) availability
 *   as a fresh signal and fire on it, proving detect -> compare -> dispatch -> Expo -> device
 *   works end to end. Run `pnpm probe` first if you're not sure which variant that is. If every
 *   variant is genuinely sold out, this script will still reset the state, but no push will
 *   follow -- that's correct behavior, not a bug in this script.
 *
 * Uses `wrangler kv key get/put/list` under `pnpm --filter @astra/worker exec`, so it always
 * resolves the same `wrangler` binary and `wrangler.toml` the real deploy uses -- no hardcoded
 * paths to guess at, and no coupling to worker/src/** internals.
 *
 * Reversible: it prints the exact value it overwrote and the exact command to restore it.
 *
 * Run with:
 *   pnpm simulate-restock                      list variant states currently in KV
 *   pnpm simulate-restock <variantId>           reset that variant's latch
 *   pnpm simulate-restock <variantId> --dry-run show what would be written, write nothing
 */

import { execFileSync } from 'node:child_process';

import { KV_KEYS } from '../packages/contract/src/index.js';
import type { VariantState } from '../packages/contract/src/index.js';

// Must match the `binding` name in worker/wrangler.toml's [[kv_namespaces]] entry.
const KV_BINDING = 'STOCK_KV';
const VARIANT_KEY_PREFIX = KV_KEYS.variantState(''); // derived from the contract, not hardcoded

function log(line = ''): void {
  console.log(line);
}

interface WranglerResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Shell out via `pnpm --filter @astra/worker exec wrangler ...` rather than invoking a wrangler
 * binary path directly: pnpm resolves the correct local `wrangler` (from worker/'s own
 * devDependencies) and runs it with cwd = worker/, so wrangler.toml is auto-discovered exactly
 * the way `pnpm --filter @astra/worker deploy` finds it. Nothing here has to guess at
 * node_modules layout.
 */
/**
 * Windows resolves `pnpm` and `npx` to `.cmd` shims, and since Node's CVE-2024-27980 fix
 * `execFile` refuses to run a `.cmd` at all — it fails with EINVAL whether or not the name is
 * suffixed. The shell has to do the resolution, so `shell: true` is required on Windows rather
 * than merely convenient. Every argument passed here is an internal constant with no spaces or
 * metacharacters, so shell quoting carries no injection risk.
 */
const IS_WINDOWS = process.platform === 'win32';

function runWrangler(args: string[]): WranglerResult {
  try {
    const stdout = execFileSync('pnpm', ['--filter', '@astra/worker', 'exec', 'wrangler', ...args], {
      shell: IS_WINDOWS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; code?: string; message?: string };
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        status: null,
        stdout: '',
        stderr: 'pnpm was not found on PATH. Run this from inside the project with pnpm available.',
      };
    }
    return {
      ok: false,
      status: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
    };
  }
}

/** Returns the raw string value, or null if the key does not exist (or wrangler couldn't say). */
function kvGet(key: string): string | null {
  // --text: every value this project stores is JSON text, so decode as utf8 rather than letting
  // wrangler treat it as an opaque byte blob.
  const res = runWrangler(['kv', 'key', 'get', key, '--binding', KV_BINDING, '--text']);
  if (res.ok) {
    const trimmed = res.stdout.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (/not found|does not exist|no value/i.test(res.stderr)) return null;
  throw new Error(
    `wrangler kv key get "${key}" failed (exit ${res.status ?? 'unknown'}): ${res.stderr.trim() || '(no stderr)'}`,
  );
}

function kvPut(key: string, value: string): void {
  const res = runWrangler(['kv', 'key', 'put', key, value, '--binding', KV_BINDING]);
  if (!res.ok) {
    throw new Error(
      `wrangler kv key put "${key}" failed (exit ${res.status ?? 'unknown'}): ${res.stderr.trim() || '(no stderr)'}`,
    );
  }
}

interface KvListEntry {
  name: string;
}

function kvListVariantKeys(): string[] {
  const res = runWrangler(['kv', 'key', 'list', '--binding', KV_BINDING, '--prefix', VARIANT_KEY_PREFIX]);
  if (!res.ok) {
    throw new Error(`wrangler kv key list failed (exit ${res.status ?? 'unknown'}): ${res.stderr.trim() || '(no stderr)'}`);
  }
  try {
    const parsed = JSON.parse(res.stdout) as KvListEntry[];
    return parsed.map((e) => e.name);
  } catch (err) {
    throw new Error(`could not parse \`wrangler kv key list\` output as JSON: ${err instanceof Error ? err.message : err}`);
  }
}

async function listAndExit(): Promise<void> {
  log('No variant id given. Listing variant states currently in KV...');
  log('');
  let keys: string[];
  try {
    keys = kvListVariantKeys();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    log('');
    log('Common causes: `wrangler login` not done yet, the KV namespace id in worker/wrangler.toml');
    log('is still the REPLACE_WITH_... placeholder, or `pnpm install` has not been run so the');
    log('local wrangler binary does not exist yet. See the README credential checklist.');
    process.exitCode = 1;
    return;
  }

  if (keys.length === 0) {
    log('(none found)');
    log('');
    log('This is expected if the worker has not completed a cron pass yet, or has only ever seen');
    log('variants as sold out and never written a state for them. Run `pnpm probe` to see live');
    log('variant ids from the store, then re-run this script with one of them directly -- it will');
    log('create a fresh state even if KV has never seen that id before:');
    log('  pnpm simulate-restock <variantId>');
    process.exitCode = 1;
    return;
  }

  log(`Found ${keys.length} variant state key(s):`);
  for (const key of keys) {
    const variantId = key.slice(VARIANT_KEY_PREFIX.length);
    let raw: string | null;
    try {
      raw = kvGet(key);
    } catch (err) {
      raw = null;
      log(`  ${variantId}  ->  (could not read: ${err instanceof Error ? err.message : err})`);
      continue;
    }
    log(`  ${variantId}  ->  ${raw ?? '(empty)'}`);
  }
  log('');
  log('Re-run with one of the ids above: pnpm simulate-restock <variantId> [--dry-run]');
  process.exitCode = 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const variantId = args.find((a) => !a.startsWith('--'));

  if (!variantId) {
    await listAndExit();
    return;
  }

  const key = KV_KEYS.variantState(variantId);
  log(`Target key: ${key}   (binding: ${KV_BINDING}, remote KV -- no --local flag)`);
  log('');

  let currentRaw: string | null;
  try {
    currentRaw = kvGet(key);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    log('');
    log('Common causes: `wrangler login` not done yet, or the KV namespace id in');
    log('worker/wrangler.toml is still the REPLACE_WITH_... placeholder. See the README');
    log('credential checklist.');
    process.exitCode = 1;
    return;
  }
  log(currentRaw ? `Current value: ${currentRaw}` : 'Current value: (not set -- no recorded state for this variant yet)');

  const forced: VariantState = { available: false, lastAlertedAt: null, lastChangedAt: Date.now() };
  const forcedRaw = JSON.stringify(forced);

  log('');
  log('This resets the alert latch only. The worker still fetches the REAL store on its next cron');
  log('tick and compares against this. A push fires ONLY if that real fetch reports this variant');
  log('as available. If it is genuinely sold out right now, expect no push -- pick a variant that');
  log('IS currently purchasable (run `pnpm probe` if unsure which one that is).');
  log('');
  log(`Will write: ${forcedRaw}`);

  if (dryRun) {
    log('');
    log('--dry-run: no write performed.');
    process.exitCode = 0;
    return;
  }

  try {
    kvPut(key, forcedRaw);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  log('');
  log('Done. Within ~60 seconds the next cron tick should:');
  log('  1. fetch the store and detect this variant');
  log('  2. if it is available: observe false -> true, and send an Expo push to every device');
  log('     subscribed to this variant (or to all variants, for devices registered with an empty');
  log('     variantIds list)');
  log('  3. write back {available:true, lastAlertedAt:<now>} and start the cooldown window');
  log('');
  log('Watch a registered device for the notification, or poll GET /status on the deployed worker.');
  log('');
  log('To undo -- restore exactly what was there before this script ran -- run:');
  if (currentRaw) {
    log(`  pnpm --filter @astra/worker exec wrangler kv key put "${key}" '${currentRaw}' --binding ${KV_BINDING}`);
  } else {
    log(`  pnpm --filter @astra/worker exec wrangler kv key delete "${key}" --binding ${KV_BINDING}`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('simulate-restock crashed unexpectedly:', err);
  process.exitCode = 1;
});
