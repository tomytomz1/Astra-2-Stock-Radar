/**
 * pnpm simulate-restock <variantId> [--dry-run]
 * pnpm simulate-restock --heartbeat   force the weekly liveness ping on the next pass
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

import { HEARTBEAT_INTERVAL_MS, KV_KEYS } from '../packages/contract/src/index.js';
import type { VariantState } from '../packages/contract/src/index.js';

/** The one-shot trigger key. Named in the contract so the worker and this script cannot drift. */
const FORCE_KEY = KV_KEYS.forceAlert;

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
 * `wrangler kv` refuses to guess which namespace to touch when wrangler.toml carries both `id`
 * and `preview_id` -- which `pnpm bootstrap` deliberately writes, since `preview_id` is what
 * `wrangler dev` binds. Every `kv` subcommand therefore needs an explicit `--preview false` to
 * target the production namespace the deployed worker actually reads. Non-`kv` subcommands do
 * not accept the flag, so it is added only where it applies.
 */
function withPreviewFlag(args: string[]): string[] {
  // `kv key ...` only. `kv namespace create --preview` means something entirely different --
  // create the preview namespace -- so the flag must not be sprayed across every kv subcommand.
  return args[0] === 'kv' && args[1] === 'key' ? [...args, '--preview', 'false'] : args;
}

/**
 * Running pnpm without a shell, on every platform.
 *
 * Windows resolves `pnpm` to a `.cmd` shim, and since Node's CVE-2024-27980 fix `execFile`
 * refuses to run one at all (EINVAL, suffixed or not). `shell: true` works but concatenates
 * arguments instead of escaping them — Node warns about exactly this (DEP0190), and
 * `simulate-restock` passes a variant id straight from the command line, so the concern is real
 * here rather than theoretical.
 *
 * `npm_execpath` is set by pnpm for any script it runs and points at pnpm's own JS entrypoint,
 * so invoking Node on it directly sidesteps the shim entirely: no shell, arguments passed as a
 * real array, nothing to escape. The shell path remains only as a fallback for direct
 * `tsx scripts/...` invocation outside a pnpm script.
 */
const PNPM_JS: string | undefined = process.env.npm_execpath;

function pnpmCommand(args: string[]): { file: string; args: string[]; shell: boolean } {
  if (PNPM_JS !== undefined && PNPM_JS !== '') {
    return { file: process.execPath, args: [PNPM_JS, ...args], shell: false };
  }
  return { file: 'pnpm', args, shell: process.platform === 'win32' };
}

function runWrangler(args: string[]): WranglerResult {
  try {
    const spec = pnpmCommand(['--filter', '@astra/worker', 'exec', 'wrangler', ...withPreviewFlag(args)]);
    const stdout = execFileSync(spec.file, spec.args, {
      shell: spec.shell,
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

/**
 * Parse a JSON array out of wrangler's stdout.
 *
 * `JSON.parse(stdout)` assumed stdout was nothing but JSON. Wrangler 4 breaks that assumption --
 * it prints a first-run telemetry notice, and update banners appear on any version -- so a
 * perfectly good response can arrive with prose in front of it. Slicing from the first bracket to
 * the last is what keeps `kv namespace list` and `kv key list` working across wrangler versions.
 */
function parseJsonArray<T>(stdout: string): T[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new SyntaxError('no JSON array found in wrangler output');
  }
  return JSON.parse(stdout.slice(start, end + 1)) as T[];
}

function kvListVariantKeys(): string[] {
  const res = runWrangler(['kv', 'key', 'list', '--binding', KV_BINDING, '--prefix', VARIANT_KEY_PREFIX]);
  if (!res.ok) {
    throw new Error(`wrangler kv key list failed (exit ${res.status ?? 'unknown'}): ${res.stderr.trim() || '(no stderr)'}`);
  }
  try {
    const parsed = parseJsonArray<KvListEntry>(res.stdout);
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
  const heartbeatOnly = args.includes('--heartbeat');

  if (heartbeatOnly) {
    // Clearing `lastHeartbeatAt` makes the next successful pass send a liveness ping. Without
    // this the feature is unverifiable for seven days -- the same "first real test is the moment
    // it matters" trap the force-alert trigger exists to avoid.
    log('Clearing lastHeartbeatAt so the next cron pass sends a liveness heartbeat.');
    log('');
    const raw = kvGet(KV_KEYS.health);
    if (raw === null) {
      log('No health record yet. The worker has not completed a successful pass; try again in a minute.');
      process.exitCode = 1;
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log(`Health record is not valid JSON, refusing to overwrite it: ${raw.slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
    // Back-dated rather than nulled: null starts the clock instead of firing, by design.
    const next = { ...parsed, lastHeartbeatAt: Date.now() - HEARTBEAT_INTERVAL_MS - 1000 };
    log(`Will write: ${KV_KEYS.health} with lastHeartbeatAt back-dated past the weekly interval.`);
    if (dryRun) {
      log('');
      log('--dry-run: no write performed.');
      return;
    }
    kvPut(KV_KEYS.health, JSON.stringify(next));
    log('');
    log('Done. Within ~60 seconds you should receive a "watcher is running" notification on the');
    log('watcher-health channel (quieter than a restock alert -- that separation is deliberate).');
    log('If it does not arrive, no device is registered: open the app once to re-register.');
    return;
  }
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
  log('Two things are written:');
  log('');
  log(`  1. the alert latch for this variant, reset so a genuine restock can fire again:`);
  log(`     ${key} = ${forcedRaw}`);
  log(`  2. a one-shot test trigger the next cron pass consumes and deletes:`);
  log(`     ${FORCE_KEY} = ${variantId}`);
  log('');
  log('The trigger is what actually produces a notification. Resetting the latch alone cannot:');
  log('the worker re-reads the live store every pass, so on a sold-out product it sees no');
  log('false -> true edge and correctly sends nothing.');

  if (dryRun) {
    log('');
    log('--dry-run: no write performed.');
    process.exitCode = 0;
    return;
  }

  try {
    kvPut(key, forcedRaw);
    kvPut(FORCE_KEY, variantId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  log('');
  log('Done. Within ~60 seconds the next cron tick should:');
  log('  1. fetch the live store and read every variant as usual');
  log('  2. consume the test trigger and send a real Expo push for this variant to every device');
  log('     subscribed to it (or to all variants, for devices registered with an empty list)');
  log('  3. delete the trigger, so the pass after this one is silent');
  log('');
  log('The notification is byte-identical to a genuine restock alert -- that is deliberate, since');
  log('an alert that looks different would not be testing the thing you care about.');
  log('');
  log('Watch a registered device for the notification, or poll GET /status on the deployed worker.');
  log('');
  log('To undo -- restore exactly what was there before this script ran -- run:');
  // `--preview false` is not optional: wrangler.toml carries both id and preview_id, and
  // `kv key` refuses to guess which namespace is meant.
  const suffix = `--binding ${KV_BINDING} --preview false`;
  if (currentRaw) {
    log(`  pnpm --filter @astra/worker exec wrangler kv key put "${key}" '${currentRaw}' ${suffix}`);
  } else {
    log(`  pnpm --filter @astra/worker exec wrangler kv key delete "${key}" ${suffix}`);
  }
  log(`  pnpm --filter @astra/worker exec wrangler kv key delete "${FORCE_KEY}" ${suffix}`);
  log('');
  log('The trigger deletes itself on the next pass, so the second command only matters if you');
  log('want to cancel before the cron fires.');
  process.exitCode = 0;
}

main().catch((err) => {
  console.error('simulate-restock crashed unexpectedly:', err);
  process.exitCode = 1;
});
