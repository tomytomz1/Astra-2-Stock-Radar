/**
 * pnpm bootstrap -- [--dry-run]
 *
 * Collapses the Cloudflare half of onboarding -- login check, KV namespace creation, patching
 * `worker/wrangler.toml`, deploying, and patching `app/eas.json` with the deployed URL -- into
 * one command. Those last two steps used to be manual copy-paste-into-file edits; this script
 * exists because that transcription is the likeliest thing to go silently wrong, and a wrong
 * worker URL means the app registers nowhere and nobody finds out until a drop.
 *
 * WHAT THIS DOES, IN ORDER:
 *   1. Checks you're logged in to wrangler (`wrangler whoami`). Never attempts to log you in.
 *   2. Lists existing KV namespaces and reuses one matching the expected title, or creates a
 *      production + preview namespace if none exists.
 *   3. Patches the `id` / `preview_id` placeholders in `worker/wrangler.toml` -- surgically, by
 *      exact-line replacement, never touching the surrounding comments. Never overwrites an id
 *      that is already a real value.
 *   4. Deploys the worker (`wrangler deploy`) and parses the printed `*.workers.dev` URL.
 *   5. Writes that URL into `app/eas.json`'s `build.preview.env.EXPO_PUBLIC_WORKER_URL`.
 *   6. Prints a summary: which files changed, the worker URL, and the next command to run.
 *
 * `--dry-run` walks through every step and prints what it *would* do, but creates nothing,
 * deploys nothing, and writes nothing -- `git diff` after a dry run is always empty. Read-only
 * checks (`wrangler whoami`, `wrangler kv namespace list`) still run in dry-run mode, since they
 * don't touch anything and are needed to report an accurate plan; the mutating calls (namespace
 * create, deploy, and both file writes) are skipped and described instead.
 *
 * Standalone, like `probe.ts` and `simulate-restock.ts`: no import from `worker/src/**`. Reuses
 * the same shell-out-to-wrangler pattern as `simulate-restock.ts` (`pnpm --filter @astra/worker
 * exec wrangler ...`), so wrangler.toml and the local wrangler binary resolve identically no
 * matter which script runs them.
 *
 * Run with:
 *   pnpm bootstrap                do it for real
 *   pnpm bootstrap --dry-run  print the plan, touch nothing
 */

import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const WRANGLER_TOML_PATH = join(REPO_ROOT, 'worker', 'wrangler.toml');
/**
 * The committed template. `wrangler.toml` itself is gitignored because this script rewrites it
 * with real Cloudflare namespace ids -- tracking a file every checkout is expected to modify made
 * `git pull` abort on any edit to it, and put a real id one `git add -A` away from being public.
 */
const WRANGLER_TOML_TEMPLATE_PATH = join(REPO_ROOT, 'worker', 'wrangler.toml.example');
const EAS_JSON_PATH = join(REPO_ROOT, 'app', 'eas.json');

// Must match the `binding` name in worker/wrangler.toml's [[kv_namespaces]] entry (mirrors the
// same hardcode-with-comment `simulate-restock.ts` uses, for the same reason: this script is
// standalone and must not import worker/src/** to find it out).
const KV_BINDING = 'STOCK_KV';

const PLACEHOLDER_ID = 'REPLACE_WITH_KV_NAMESPACE_ID';
const PLACEHOLDER_PREVIEW_ID = 'REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID';
const ID_LINE = `id = "${PLACEHOLDER_ID}"`;
const PREVIEW_ID_LINE = `preview_id = "${PLACEHOLDER_PREVIEW_ID}"`;

const WHOAMI_TIMEOUT_MS = 20_000;

const DRY_RUN = process.argv.includes('--dry-run');

function log(line = ''): void {
  console.log(line);
}

function divider(): void {
  log('-'.repeat(72));
}

function step(n: number, title: string): void {
  log('');
  divider();
  log(`Step ${n}: ${title}`);
  divider();
}

function indent(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

/** An anticipated, actionable failure -- printed as a clean message, not a stack trace. */
class SetupError extends Error {}

// ---------------------------------------------------------------------------
// wrangler shell-out (same pattern as scripts/simulate-restock.ts)
// ---------------------------------------------------------------------------

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
 * the way `pnpm --filter @astra/worker deploy` and `simulate-restock.ts` both find it.
 */
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

function runWrangler(args: string[], timeoutMs?: number): WranglerResult {
  try {
    const spec = pnpmCommand(['--filter', '@astra/worker', 'exec', 'wrangler', ...args]);
    const stdout = execFileSync(
      spec.file,
      spec.args,
      {
        encoding: 'utf8',
        shell: spec.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      },
    );
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; code?: string; signal?: string; message?: string };
    if (e.code === 'ENOENT') {
      return {
        ok: false,
        status: null,
        stdout: '',
        stderr: 'pnpm was not found on PATH. Run this from inside the project with pnpm available.',
      };
    }
    if (e.signal) {
      return {
        ok: false,
        status: null,
        stdout: e.stdout ?? '',
        stderr: `timed out or was killed (signal ${e.signal}) -- likely a blocked or unreachable network`,
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

// ---------------------------------------------------------------------------
// Step 1: wrangler auth
// ---------------------------------------------------------------------------

function checkWranglerAuth(): void {
  step(1, 'Check wrangler authentication');
  const res = runWrangler(['whoami'], WHOAMI_TIMEOUT_MS);

  if (!res.ok) {
    throw new SetupError(
      [
        'Could not run `wrangler whoami`. This happens both when you are not logged in and when',
        'the Cloudflare API is unreachable from this network (blocked proxy, no network, or a',
        'timeout) -- this script cannot tell those apart, so it stops here rather than guess:',
        '',
        indent(res.stderr || res.stdout || '(no output captured)'),
        '',
        'Next step: from a machine with real network access to Cloudflare, run this exact command',
        '(it opens a browser):',
        '',
        '  npx wrangler login',
        '',
        'Then re-run `pnpm bootstrap`.',
      ].join('\n'),
    );
  }

  if (/not authenticated|not logged in|please run.*wrangler login/i.test(res.stdout)) {
    throw new SetupError(
      [
        'Not logged in to wrangler.',
        '',
        'Next step: run this exact command (it opens a browser):',
        '',
        '  npx wrangler login',
        '',
        'Then re-run `pnpm bootstrap`.',
      ].join('\n'),
    );
  }

  log('Authenticated:');
  log(indent(res.stdout));
}

// ---------------------------------------------------------------------------
// Step 2 + 3: resolve KV namespace ids and patch worker/wrangler.toml
// ---------------------------------------------------------------------------

interface WranglerTomlState {
  raw: string;
  /** Real id already configured, or null if it's still the REPLACE_WITH_... placeholder. */
  id: string | null;
  previewId: string | null;
  workerName: string | null;
}

/**
 * Create `wrangler.toml` from the template when it does not exist yet.
 *
 * Returns whether it created one, so the summary can say so. Never overwrites: an existing file
 * holds this deployment's real ids, and clobbering it would be the single most destructive thing
 * this script could do.
 */
async function ensureWranglerToml(dryRun: boolean): Promise<boolean> {
  if (existsSync(WRANGLER_TOML_PATH)) return false;
  if (!existsSync(WRANGLER_TOML_TEMPLATE_PATH)) {
    throw new Error(
      `Neither worker/wrangler.toml nor worker/wrangler.toml.example exists. The template is ` +
        `committed, so this usually means an incomplete checkout -- try \`git checkout ` +
        `worker/wrangler.toml.example\`.`,
    );
  }
  if (dryRun) {
    log('worker/wrangler.toml does not exist. Would create it from worker/wrangler.toml.example.');
    return true;
  }
  await copyFile(WRANGLER_TOML_TEMPLATE_PATH, WRANGLER_TOML_PATH);
  log('Created worker/wrangler.toml from worker/wrangler.toml.example.');
  return true;
}

async function readWranglerToml(): Promise<WranglerTomlState> {
  // Falls back to the template so `--dry-run` can plan against a checkout that has no
  // wrangler.toml yet -- dry-run creates nothing, so the real file may legitimately be absent.
  const source = existsSync(WRANGLER_TOML_PATH) ? WRANGLER_TOML_PATH : WRANGLER_TOML_TEMPLATE_PATH;
  const raw = await readFile(source, 'utf8');
  const nameMatch = raw.match(/^name\s*=\s*"([^"]+)"/m);
  const idMatch = raw.match(/^id = "([^"]*)"$/m);
  const previewMatch = raw.match(/^preview_id = "([^"]*)"$/m);
  const id = idMatch?.[1] ?? null;
  const previewId = previewMatch?.[1] ?? null;
  return {
    raw,
    id: id && id !== PLACEHOLDER_ID ? id : null,
    previewId: previewId && previewId !== PLACEHOLDER_PREVIEW_ID ? previewId : null,
    workerName: nameMatch?.[1] ?? null,
  };
}

interface KvNamespaceListEntry {
  id: string;
  title: string;
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

function listKvNamespaces(): KvNamespaceListEntry[] {
  const res = runWrangler(['kv', 'namespace', 'list']);
  if (!res.ok) {
    throw new SetupError(
      `\`wrangler kv namespace list\` failed (exit ${res.status ?? 'unknown'}):\n${indent(res.stderr || res.stdout || '(no output)')}`,
    );
  }
  try {
    return parseJsonArray<KvNamespaceListEntry>(res.stdout);
  } catch (err) {
    throw new SetupError(
      `Could not parse \`wrangler kv namespace list\` output as JSON: ${err instanceof Error ? err.message : String(err)}\n\nRaw output:\n${indent(res.stdout)}`,
    );
  }
}

/**
 * Create a KV namespace and parse its id out of wrangler's printed TOML snippet, e.g.
 * `{ binding = "STOCK_KV", id = "abcd1234..." }` (or `preview_id = "..."` with `--preview`).
 * wrangler versions vary in exact phrasing, so this also falls back to any bare 32-char hex
 * string in the output -- KV namespace ids have that shape. If neither is found, this throws
 * with the full wrangler output attached rather than writing something guessed.
 */
function createKvNamespace(preview: boolean): string {
  const args = ['kv', 'namespace', 'create', KV_BINDING];
  if (preview) args.push('--preview');
  const res = runWrangler(args);
  if (!res.ok) {
    throw new SetupError(
      `\`wrangler kv namespace create${preview ? ' --preview' : ''}\` failed (exit ${res.status ?? 'unknown'}):\n${indent(res.stderr || res.stdout || '(no output)')}`,
    );
  }
  const field = preview ? 'preview_id' : 'id';
  const fieldMatch = res.stdout.match(new RegExp(`${field}\\s*[:=]\\s*"?([0-9a-f]{16,})"?`, 'i'));
  const bareHexMatch = res.stdout.match(/\b[0-9a-f]{32}\b/i);
  const found = fieldMatch?.[1] ?? bareHexMatch?.[0];
  if (!found) {
    throw new SetupError(
      [
        `wrangler created the namespace but its ${field} could not be parsed from the output below.`,
        'Find it yourself and paste it into worker/wrangler.toml manually:',
        '',
        '  pnpm --filter @astra/worker exec wrangler kv namespace list',
        '',
        '--- wrangler output ---',
        indent(res.stdout || '(empty)'),
        indent(res.stderr || ''),
      ].join('\n'),
    );
  }
  return found;
}

interface NamespaceResolution {
  id: string;
  /** Human-readable note on where the id came from, for the step-3 log. */
  source: 'existing-config' | 'reused' | 'created' | 'would-create';
}

async function resolveKvNamespaceId(opts: {
  preview: boolean;
  workerName: string;
  existingId: string | null;
}): Promise<NamespaceResolution> {
  const label = opts.preview ? 'preview' : 'production';

  if (opts.existingId) {
    log(`${label}: worker/wrangler.toml already has a real id (${opts.existingId}) -- leaving it alone.`);
    return { id: opts.existingId, source: 'existing-config' };
  }

  // Assumes wrangler's own title-generation convention for a namespace created with a bare
  // binding-name argument: "<worker-name>-<binding>", and "..._preview" with --preview. This is
  // consistent across wrangler 2.x/3.x but is wrangler's behavior, not this repo's contract --
  // if a future wrangler version changes it, dedup just falls through to creating a namespace
  // (safe: never a duplicate silently used, just a possible extra one to merge by hand).
  const expectedTitle = opts.preview ? `${opts.workerName}-${KV_BINDING}_preview` : `${opts.workerName}-${KV_BINDING}`;
  log(`${label}: no real id configured yet. Looking for an existing namespace titled "${expectedTitle}"...`);

  const namespaces = listKvNamespaces();
  const existing = namespaces.find((ns) => ns.title === expectedTitle);
  if (existing) {
    log(`${label}: found existing namespace "${existing.title}" (id ${existing.id}) -- reusing it, not creating a duplicate.`);
    return { id: existing.id, source: 'reused' };
  }

  if (DRY_RUN) {
    log(`${label}: no existing namespace found. Would run: wrangler kv namespace create ${KV_BINDING}${opts.preview ? ' --preview' : ''}`);
    return { id: '(id assigned on creation)', source: 'would-create' };
  }

  log(`${label}: no existing namespace found. Creating one...`);
  const id = createKvNamespace(opts.preview);
  log(`${label}: created namespace (id ${id}).`);
  return { id, source: 'created' };
}

/** Exact-line replacement -- never rewrites the whole file, so the surrounding comments survive. */
function replaceExactlyOnce(text: string, searchLine: string, replacementLine: string): string {
  const occurrences = text.split(searchLine).length - 1;
  if (occurrences === 0) return text;
  if (occurrences > 1) {
    throw new SetupError(
      `Found ${occurrences} occurrences of ${JSON.stringify(searchLine)} in worker/wrangler.toml -- ` +
        'refusing to guess which to replace. Edit the file by hand instead.',
    );
  }
  return text.replace(searchLine, replacementLine);
}

/** Patches only the fields passed in (non-null); returns which field names were actually changed. */
async function patchWranglerToml(newId: string | null, newPreviewId: string | null): Promise<string[]> {
  let raw = await readFile(WRANGLER_TOML_PATH, 'utf8');
  const changed: string[] = [];

  if (newId) {
    const before = raw;
    raw = replaceExactlyOnce(raw, ID_LINE, `id = "${newId}"`);
    if (raw !== before) changed.push('id');
  }
  if (newPreviewId) {
    const before = raw;
    raw = replaceExactlyOnce(raw, PREVIEW_ID_LINE, `preview_id = "${newPreviewId}"`);
    if (raw !== before) changed.push('preview_id');
  }
  if (changed.length > 0) {
    await writeFile(WRANGLER_TOML_PATH, raw, 'utf8');
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Step 4: deploy
// ---------------------------------------------------------------------------

type DeployOutcome = { ok: true; url: string } | { ok: false; reason: 'dry-run' | 'unparseable' };

async function deployWorker(): Promise<DeployOutcome> {
  step(4, 'Deploy the worker');

  if (DRY_RUN) {
    log('--dry-run: would run `wrangler deploy` and parse the printed *.workers.dev URL from its output.');
    return { ok: false, reason: 'dry-run' };
  }

  log('Running `wrangler deploy`...');
  const res = runWrangler(['deploy']);
  if (!res.ok) {
    throw new SetupError(
      [
        `\`wrangler deploy\` failed (exit ${res.status ?? 'unknown'}):`,
        '',
        indent(res.stderr || res.stdout || '(no output)'),
        '',
        'Common causes: not logged in, an invalid KV namespace id in worker/wrangler.toml, or a',
        '`compatibility_date` wrangler no longer recognizes. Fix the error above and re-run `pnpm bootstrap`.',
      ].join('\n'),
    );
  }
  log(res.stdout.trim());

  const match = res.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\S*/i);
  if (!match) {
    log('');
    log('WARNING: deploy succeeded, but no *.workers.dev URL could be parsed from the output above.');
    log('Find it in the Cloudflare dashboard (Workers & Pages -> your worker) and paste it into');
    log('app/eas.json yourself, under build.preview.env.EXPO_PUBLIC_WORKER_URL.');
    return { ok: false, reason: 'unparseable' };
  }
  const url = match[0].replace(/[),.]+$/, ''); // trim any trailing punctuation swept up by the match
  log(`Worker URL: ${url}`);
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Step 5: patch app/eas.json
// ---------------------------------------------------------------------------

interface EasJson {
  build?: {
    preview?: {
      env?: Record<string, string>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function patchEasJson(deployOutcome: DeployOutcome): Promise<boolean> {
  step(5, "Write the worker URL into app/eas.json's preview profile");

  if (!deployOutcome.ok) {
    log(
      deployOutcome.reason === 'dry-run'
        ? '--dry-run: deploy was skipped, so there is no URL to write. On a real run this would'
        : 'No worker URL available (see the warning above) -- leaving app/eas.json untouched.',
    );
    if (deployOutcome.reason === 'dry-run') {
      log('update build.preview.env.EXPO_PUBLIC_WORKER_URL with the deployed URL.');
    }
    return false;
  }

  const workerUrl = deployOutcome.url;
  const raw = await readFile(EAS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as EasJson;

  if (!parsed.build || !parsed.build.preview) {
    throw new SetupError(
      "app/eas.json has no build.preview profile -- this script expects one (see app/eas.json's " +
        'current shape). Edit the file by hand instead.',
    );
  }

  const currentUrl = parsed.build.preview.env?.EXPO_PUBLIC_WORKER_URL;
  if (currentUrl === workerUrl) {
    log(`build.preview.env.EXPO_PUBLIC_WORKER_URL is already "${workerUrl}" -- nothing to change.`);
    return false;
  }

  log(`build.preview.env.EXPO_PUBLIC_WORKER_URL: ${currentUrl ?? '(unset)'} -> ${workerUrl}`);

  if (DRY_RUN) {
    log('--dry-run: would write this change, preserving the file\'s existing JSON formatting.');
    return false;
  }

  parsed.build.preview.env = { ...parsed.build.preview.env, EXPO_PUBLIC_WORKER_URL: workerUrl };
  // JSON.parse/stringify round-trips key order for existing keys, and app/eas.json is plain JSON
  // (no comments to lose) -- so 2-space indent + stringify preserves formatting faithfully.
  await writeFile(EAS_JSON_PATH, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  log('Wrote app/eas.json.');
  return true;
}

// ---------------------------------------------------------------------------
// Step 6: summary
// ---------------------------------------------------------------------------

function printSummary(opts: { changedFiles: string[]; deployOutcome: DeployOutcome }): void {
  step(6, 'Summary');

  if (DRY_RUN) {
    log('DRY RUN -- nothing was created, deployed, or written. The plan above is what a real run');
    log('(`pnpm bootstrap`) would do.');
  } else if (opts.changedFiles.length === 0) {
    log('No files needed changes -- KV namespace ids and the worker URL were already up to date.');
  } else {
    log('Files changed:');
    for (const f of opts.changedFiles) log(`  - ${f}`);
  }

  log('');
  if (opts.deployOutcome.ok) {
    log(`Worker URL: ${opts.deployOutcome.url}`);
  } else if (opts.deployOutcome.reason === 'dry-run') {
    log('Worker URL: (not deployed -- dry run)');
  } else {
    log('Worker URL: unknown -- see the WARNING above, find it in the Cloudflare dashboard and');
    log('paste it into app/eas.json yourself.');
  }

  log('');
  log('Next:');
  log('  npx eas login');
  log('  eas build --profile preview --platform all');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(DRY_RUN ? 'pnpm bootstrap --dry-run  (planning only -- nothing will be created, deployed, or written)' : 'pnpm bootstrap');

  checkWranglerAuth();

  step(2, 'Resolve the KV namespace (idempotent)');
  await ensureWranglerToml(DRY_RUN);
  const tomlState = await readWranglerToml();
  if (!tomlState.workerName) {
    throw new SetupError(
      'Could not find `name = "..."` in worker/wrangler.toml -- has the file format changed? Edit it by hand.',
    );
  }
  log(`Worker name (from wrangler.toml): ${tomlState.workerName}`);
  log(`KV binding: ${KV_BINDING}`);
  log('');

  const prod = await resolveKvNamespaceId({ preview: false, workerName: tomlState.workerName, existingId: tomlState.id });
  const preview = await resolveKvNamespaceId({ preview: true, workerName: tomlState.workerName, existingId: tomlState.previewId });

  step(3, 'Patch worker/wrangler.toml');
  const changedFiles: string[] = [];
  if (DRY_RUN) {
    log(tomlState.id ? 'id: already a real value -- would leave alone.' : `id: would write "${prod.id}"`);
    log(tomlState.previewId ? 'preview_id: already a real value -- would leave alone.' : `preview_id: would write "${preview.id}"`);
  } else {
    // Only ever pass in ids that are actually new this run -- an existing real id must never be
    // handed to patchWranglerToml, since that function's whole contract is "only fields I'm told
    // to write get written," and a field with no matching placeholder line is silently skipped.
    const toWriteId = tomlState.id ? null : prod.id;
    const toWritePreviewId = tomlState.previewId ? null : preview.id;
    const changed = await patchWranglerToml(toWriteId, toWritePreviewId);
    if (changed.length > 0) {
      log(`Patched worker/wrangler.toml (${changed.join(', ')}).`);
      changedFiles.push('worker/wrangler.toml');
    } else {
      log('worker/wrangler.toml already had real ids for both fields -- nothing to patch.');
    }
  }

  const deployOutcome = await deployWorker();

  const easChanged = await patchEasJson(deployOutcome);
  if (easChanged) changedFiles.push('app/eas.json');

  printSummary({ changedFiles, deployOutcome });

  process.exitCode = 0;
}

main().catch((err) => {
  if (err instanceof SetupError) {
    log('');
    divider();
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  console.error('setup crashed unexpectedly:', err);
  process.exitCode = 1;
});
