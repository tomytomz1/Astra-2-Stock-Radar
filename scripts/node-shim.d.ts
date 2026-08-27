/**
 * Minimal ambient declarations for the handful of Node built-ins `probe.ts`,
 * `simulate-restock.ts`, and `setup.ts` touch.
 *
 * Hand-written instead of depending on `@types/node` because that would mean adding it to the
 * root `package.json` -- out of scope for the ops agent (see `.claude/agents/ops.md`), and this
 * tree has two other agents editing it at the same time. It also avoids a subtler problem: these
 * scripts live outside the pnpm workspace's package list (`packages/*`, `worker`, `app`), so even
 * if `@types/node` were installed as some other package's devDependency, pnpm's default
 * (non-hoisted) linking would not make it resolvable from here anyway. This file is the actually
 * portable fix, not a sandbox workaround.
 *
 * Deliberately narrow: only what these scripts call. `tsx`'s runtime resolution of `node:*`
 * specifiers is unaffected by any of this -- it only exists to make `tsc --noEmit` pass.
 */

declare const process: {
  readonly argv: string[];
  exitCode: number | undefined;
};

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:child_process' {
  export function execFileSync(
    command: string,
    args: string[],
    options: { encoding: 'utf8'; stdio?: Array<'pipe' | 'ignore' | 'inherit'>; timeout?: number },
  ): string;
}
