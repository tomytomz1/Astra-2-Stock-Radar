/**
 * Pre-push gate. Run `pnpm preflight` before every push.
 *
 * WHY THIS EXISTS
 *
 * Every defect that reached this repository's remote so far was found by *running* something,
 * not by reading it:
 *
 *   - the Worker sent Android `channelId: 'restock'` while the app created `'restock-alerts'`,
 *     so notifications would have silently landed on a fallback channel with the configured
 *     importance and sound discarded;
 *   - a `package.json` script named `setup` was shadowed by pnpm's own built-in `setup`
 *     command, which writes PNPM_HOME into the user's shell profile;
 *   - CI pinned pnpm both in the workflow and in `packageManager`, so the job died in four
 *     seconds having installed nothing.
 *
 * None of those is the kind of thing a careful re-read reliably catches, which is why this is a
 * deterministic script rather than a review pass. It costs nothing to run and never gets bored.
 *
 * Each check is independent and reports PASS/FAIL; the script runs ALL of them before exiting
 * rather than bailing on the first failure, because knowing about three problems in one run is
 * worth more than discovering them one push at a time.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const VERBOSE = process.argv.includes('--verbose');
/**
 * CI already runs the build steps as separate named steps, so it gets clear per-step failure
 * attribution in the UI. Re-running them inside preflight there would double the job's runtime
 * for no extra signal, so CI passes this flag and gets only the structural checks.
 */
const STRUCTURAL_ONLY = process.argv.includes('--structural-only');

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string[];
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string[] = []): void {
  results.push({ name, ok, detail });
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  process.stdout.write(`  ${label}  ${name}\n`);
  if (!ok || VERBOSE) for (const line of detail) process.stdout.write(`          ${line}\n`);
}

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

/** Last few meaningful lines of a command's output — enough to act on, not a wall of text. */
function tail(output: string, n = 12): string[] {
  return output.split('\n').filter((l) => l.trim() !== '').slice(-n);
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Strip line and block comments so a value merely *mentioned* in prose is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------------------
// 1-4: the exact commands CI runs, in CI's order
// ---------------------------------------------------------------------------

function checkBuildAndTests(): void {
  const steps: Array<[string, string, string[]]> = [
    ['lockfile is in sync (pnpm install --frozen-lockfile)', 'pnpm', ['install', '--frozen-lockfile']],
    ['workspace typecheck', 'pnpm', ['typecheck']],
    ['scripts/ typecheck', 'pnpm', ['exec', 'tsc', '--noEmit', '-p', 'scripts/tsconfig.json']],
    ['worker tests', 'pnpm', ['test']],
  ];
  for (const [name, cmd, args] of steps) {
    const { ok, output } = run(cmd, args);
    record(name, ok, ok ? [] : tail(output));
  }
}

// ---------------------------------------------------------------------------
// 5: contract values must never be hardcoded
// ---------------------------------------------------------------------------

/**
 * Any string constant exported from the contract is a value the Worker and the app must agree
 * on exactly. If one side hardcodes the literal instead of importing it, the two can drift
 * silently later — which is precisely how the Android channel ids diverged.
 *
 * Honest scope note: this cannot retroactively catch a shared value that was never added to the
 * contract in the first place. What it does is make the contract binding — once a value is in
 * there, no copy of it can reappear anywhere else.
 */
function checkNoHardcodedContractValues(): void {
  const contractPath = join(ROOT, 'packages/contract/src/index.ts');
  const contractSource = readFileSync(contractPath, 'utf8');
  const constants = new Map<string, string>();
  const re = /^export const ([A-Z][A-Z0-9_]*) = '([^']{3,})';/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contractSource)) !== null) constants.set(m[2] as string, m[1] as string);

  const violations: string[] = [];
  const files = [...walk(join(ROOT, 'worker/src')), ...walk(join(ROOT, 'app/src')), ...walk(join(ROOT, 'app'))];
  for (const file of new Set(files)) {
    if (file === contractPath) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [value, constName] of constants) {
      if (source.includes(`'${value}'`) || source.includes(`"${value}"`)) {
        violations.push(`${relative(ROOT, file)} hardcodes '${value}' — import ${constName} from @astra/contract`);
      }
    }
  }
  record(
    'no contract value is hardcoded outside the contract',
    violations.length === 0,
    violations,
  );
}

// ---------------------------------------------------------------------------
// 6: script names must not be shadowed by the package manager
// ---------------------------------------------------------------------------

/**
 * `pnpm <name>` silently runs pnpm's OWN command when `<name>` collides with a builtin, so a
 * script sitting behind a shadowed name is unreachable by its short form — and in the case of
 * `setup`, the builtin edits the user's shell profile instead. npm and pnpm both special-case
 * a handful of lifecycle names (test/start/stop/restart) as script aliases; those are safe.
 */
const PNPM_BUILTINS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'doctor', 'env', 'exec',
  'fetch', 'import', 'init', 'install', 'licenses', 'link', 'list', 'outdated', 'pack', 'patch',
  'prune', 'publish', 'rebuild', 'remove', 'root', 'run', 'server', 'setup', 'store', 'unlink',
  'update', 'why',
]);
const LIFECYCLE_ALIASES = new Set(['test', 'start', 'stop', 'restart']);

function checkNoShadowedScriptNames(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const shadowed = Object.keys(pkg.scripts ?? {})
    .filter((name) => PNPM_BUILTINS.has(name) && !LIFECYCLE_ALIASES.has(name))
    .map((name) => `script "${name}" is shadowed by pnpm's builtin \`pnpm ${name}\` — rename it`);
  record('no package.json script is shadowed by a pnpm builtin', shadowed.length === 0, shadowed);
}

// ---------------------------------------------------------------------------
// 7: every documented command must actually exist
// ---------------------------------------------------------------------------

function checkDocumentedCommandsExist(): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const defined = new Set(Object.keys(pkg.scripts ?? {}));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  // Only scan code contexts -- fenced blocks and inline backtick spans. Prose legitimately says
  // things like "shadowed by a pnpm builtin", which is not a command anybody is meant to run.
  const codeChunks: string[] = [
    ...[...readme.matchAll(/```[\s\S]*?```/g)].map((mm) => mm[0]),
    ...[...readme.matchAll(/`([^`\n]+)`/g)].map((mm) => mm[1] as string),
  ];

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const chunk of codeChunks) {
    const re = /\bpnpm (?:run )?([a-z][a-z0-9:-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk)) !== null) {
      const name = m[1] as string;
      if (seen.has(name)) continue;
      seen.add(name);
      if (defined.has(name) || PNPM_BUILTINS.has(name) || LIFECYCLE_ALIASES.has(name)) continue;
      // `pnpm --filter ...` and similar flag forms are not script names.
      if (name.startsWith('-')) continue;
      missing.push(`README references \`pnpm ${name}\`, which is neither a script nor a pnpm builtin`);
    }
  }
  record('every pnpm command in the README exists', missing.length === 0, missing);
}

// ---------------------------------------------------------------------------
// 8: CI parity — this gate must not drift from what CI actually enforces
// ---------------------------------------------------------------------------

/**
 * A pre-push gate that checks less than CI is worse than none: it produces confidence that CI
 * then contradicts. This asserts every `run:` command in the workflow is covered above.
 */
function checkCiParity(): void {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const covered = [
    /install\s+--frozen-lockfile/,
    /pnpm typecheck/,
    /tsc --noEmit -p scripts\/tsconfig\.json/,
    /pnpm test/,
    /pnpm preflight/, // this script; covered by definition
  ];
  const runLines = [...workflow.matchAll(/^\s*run:\s*(.+)$/gm)].map((mm) => (mm[1] as string).trim());
  const uncovered = runLines.filter((line) => !covered.some((re) => re.test(line)));
  record(
    'preflight covers every command CI runs',
    uncovered.length === 0,
    uncovered.map((l) => `CI runs \`${l}\` but preflight does not — add it to checkBuildAndTests`),
  );
}

// ---------------------------------------------------------------------------
// 9: nothing secret, and no unresolved placeholder in a value that must be real
// ---------------------------------------------------------------------------

function checkNoSecrets(): void {
  const patterns: Array<[RegExp, string]> = [
    [/\bsk-[A-Za-z0-9]{16,}/, 'possible API key'],
    // A real Expo token is exactly 22 base64url chars and, being random, effectively always
    // contains a digit. Test fixtures and docs placeholders ('[silver]', '[xxxx...]') are words
    // or repeated characters and match neither condition. A gate that cries wolf gets ignored,
    // so this is deliberately narrow rather than broad.
    [/ExponentPushToken\[(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{22}\]/, 'real Expo push token'],
    [/\baccount_id\s*=\s*"[0-9a-f]{20,}"/, 'Cloudflare account id'],
  ];
  const files = [
    ...walk(join(ROOT, 'worker')),
    ...walk(join(ROOT, 'app')),
    ...walk(join(ROOT, 'scripts')),
    ...walk(join(ROOT, 'packages')),
  ];
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const [re, what] of patterns) {
      if (re.test(source)) found.push(`${relative(ROOT, file)}: ${what}`);
    }
  }
  // wrangler.toml is config, not source — check it too.
  const toml = readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8');
  if (/\bid\s*=\s*"[0-9a-f]{32}"/.test(toml)) {
    found.push('worker/wrangler.toml: a real KV namespace id is committed — it should stay a placeholder');
  }
  record('no secrets or real infrastructure ids committed', found.length === 0, found);
}

// ---------------------------------------------------------------------------

function main(): void {
  process.stdout.write('\npreflight — deterministic pre-push gate\n\n');

  if (STRUCTURAL_ONLY) {
    process.stdout.write('  (--structural-only: skipping build and tests, CI runs those as named steps)\n\n');
  } else {
    checkBuildAndTests();
  }
  checkNoHardcodedContractValues();
  checkNoShadowedScriptNames();
  checkDocumentedCommandsExist();
  checkCiParity();
  checkNoSecrets();

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`\n\x1b[31mDo not push.\x1b[0m Failing: ${failed.map((f) => f.name).join(', ')}\n\n`);
    process.exit(1);
  }
  process.stdout.write('\n\x1b[32mSafe to push.\x1b[0m\n\n');
}

main();
