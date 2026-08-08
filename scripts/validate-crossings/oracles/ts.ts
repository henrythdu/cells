/** ts oracle — tsc --traceResolution (the TypeScript compiler itself).
 *  RAW phase: run every tsc pass, return the transcripts (no parsing). Cached
 *  as-is; edge extraction re-runs on every load, so extraction-logic changes
 *  never re-run tsc. */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../shared.ts';
import { allSourceFiles, inRepo, rel } from '../shared.ts';

/** tsconfigs: root + subprojects under packages/, apps/, examples/ (depth ≤ 6 —
 *  turborepo's examples nest apps/packages 4+ levels deep; the -p pass carries
 *  each project's path aliases, which the flat fallback can't know). */
export function discoverTsconfigs(repo: string): string[] {
  const tsconfigs: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.cells' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.name === 'tsconfig.json' && (depth === 0 || /(^|\/)(packages|apps|examples)(\/|$)/.test(join(dir, e.name)))) {
        tsconfigs.push(join(dir, e.name));
      }
    }
  };
  walk(repo, 0);
  return tsconfigs;
}

export interface TsRaw {
  tsconfigs: { tc: string; trace: string; listed: string[] }[];
  fallback: { trace: string } | null;
}

/** RAW ts oracle: run every tsc pass, return the transcripts (no parsing). */
export function oracleTsRaw(tscBin: string, repo: string, runFn: Run): TsRaw {
  const tsconfigs = discoverTsconfigs(repo);
  const fallbackFlags = ['--noEmit', '--traceResolution', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--skipLibCheck', '--allowJs'];
  const raw: TsRaw = { tsconfigs: [], fallback: null };
  if (tsconfigs.length === 0) {
    // Plain-JS repos (no tsconfig): one allowJs pass over every source file.
    const all = allSourceFiles(repo);
    if (all.length === 0) throw new Error(`no JS/TS source files found in ${repo}`);
    raw.fallback = { trace: runFn(tscBin, [...fallbackFlags, ...all.map((f) => join(repo, f))], repo).stdout };
    return raw;
  }
  // Files outside EVERY program (tests, unlisted dirs) get one flat allowJs pass so
  // every repo file's imports are covered. Each project's own files resolve through
  // its -p pass (with its path aliases) — no flat-mode contamination.
  const listedAll = new Set<string>();
  for (const tc of tsconfigs) {
    const trace = runFn(tscBin, ['--noEmit', '--traceResolution', '-p', tc], repo).stdout; // tsc exits nonzero on type errors — the trace is still complete
    const listed = runFn(tscBin, ['--noEmit', '--listFiles', '-p', tc], repo) // noEmit: --listFiles alone EMITS .js next to sources
      .stdout.split('\n')
      .map((f) => f.trim())
      .filter((f) => inRepo(repo, f))
      .map((f) => rel(repo, f));
    for (const f of listed) listedAll.add(f);
    raw.tsconfigs.push({ tc, trace, listed });
  }
  const uncovered = allSourceFiles(repo).filter((f) => !listedAll.has(f));
  if (uncovered.length > 0) raw.fallback = { trace: runFn(tscBin, [...fallbackFlags, ...uncovered.map((f) => join(repo, f))], repo).stdout };
  return raw;
}

/** Replay: parse cached transcripts into edges — runs with CURRENT extraction logic. */
export function oracleTsFromRaw(raw: TsRaw, repo: string): { edges: Set<string>; resolvedSpecs: Map<string, Set<string>> } {
  const edges = new Set<string>();
  const resolvedSpecs = new Map<string, Set<string>>(); // fromFile → Set<spec> (spec-level cross-check)
  for (const { trace } of raw.tsconfigs) traceEdges(trace, edges, resolvedSpecs, repo);
  if (raw.fallback) traceEdges(raw.fallback.trace, edges, resolvedSpecs, repo);
  return { edges, resolvedSpecs };
}

/** Parse a --traceResolution transcript into file→file edges + resolved specifiers. */
export function traceEdges(stdout: string, edges: Set<string>, resolvedSpecs: Map<string, Set<string>>, repo: string): void {
  let cur: { spec: string; from: string } | null = null;
  for (const line of stdout.split('\n')) {
    let m = line.match(/^======== Resolving module '([^']+)' from '([^']+)'\. ========$/);
    if (m) {
      cur = { spec: m[1], from: m[2] };
      continue;
    }
    // NodeNext lines end with " with Package ID 'x@y'. ========" — anchor on the
    // opening quote only (a path can't contain one); the trailer varies by mode.
    m = line.match(/^======== Module name '[^']+' was successfully resolved to '([^']+)'/);
    if (m && cur && inRepo(repo, m[1])) {
      const from = rel(repo, cur.from);
      const to = rel(repo, m[1]);
      if (!from.startsWith('..') && !to.startsWith('..') && to !== from) {
        edges.add(`${from}\0${to}`);
        const specs = resolvedSpecs.get(from);
        if (specs) {
          specs.add(cur.spec);
        } else {
          resolvedSpecs.set(from, new Set([cur.spec]));
        }
      }
    }
  }
}
