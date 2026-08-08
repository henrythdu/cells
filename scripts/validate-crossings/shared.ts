/** Shared plumbing for the validate-crossings audit — path normalization,
 *  subprocess running, tool discovery, source walking. All pure-ish: every
 *  function takes what it needs (no module-global repo state), which is what
 *  makes the oracle parsers unit-testable. */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Run = (cmd: string, argsArr: string[], cwd: string, env?: Record<string, string>) => RunResult;

/** Run a command; return { ok, stdout, stderr }. */
export function run(cmd: string, argsArr: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const r = spawnSync(cmd, argsArr, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** SCIP relative_path is repo-relative; path.relative() would resolve it against cwd. */
export function rel(repo: string, p: string): string {
  let s = p.replace(/^file:\/\//, '');
  if (s.startsWith('/')) s = relative(repo, s).split(sep).join('/');
  return posix.normalize(s.replace(/^\.\//, ''));
}

export function inRepo(repo: string, p: string): boolean {
  return p.startsWith(repo + sep);
}

/** Resolve a tool: env var → PATH → $HOME/go/bin (this machine's go installs land there, and PATH may carry a literal ~). */
export function findBin(envName: string, fallbackName: string, repo: string, runFn: Run): string {
  const direct = process.env[envName] || fallbackName;
  const v = runFn(direct, ['--version'], repo);
  if (v.ok) return direct;
  return join(process.env.HOME ?? '', 'go', 'bin', fallbackName);
}

/** All TS/JS source files in the repo (the fallback pass traces the ones project configs don't see). */
export function allSourceFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.cells' || e.name === '.git' || e.name === 'dist') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) out.push(rel(repo, p));
    }
  };
  walk(repo);
  return out;
}

/** Newest mtime under a root (cache fingerprints — cheap repo-state proxy). */
export function newestMtime(root: string): number {
  let max = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        if (st.mtimeMs > max) max = st.mtimeMs;
      }
    }
  };
  walk(root);
  return max;
}
