/** Java oracle — import statements × the compiler's definition map.
 *  scip-java emits refs for EVERY symbol use; Java has no symbol-shape
 *  convention separating imports from uses (same-package access, inheritance
 *  chains, return-type refs all reference class symbols). The verifiable
 *  oracle: the file's own `import` statements, resolved through scip-java's
 *  symbol→file map (the same derivation cells makes from the census —
 *  divergences here are real def-map bugs). Symbols are path-style:
 *  `scip-java maven <artifact> <version> <path>…` where <path> ends at the
 *  first descriptor char (# . ( ) — class/field/method). Build output
 *  (target/) is skipped — src defs are the truth. */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedOracle } from '../compare.ts';
import type { Run } from '../shared.ts';
import { rel } from '../shared.ts';
import { decodeScipIndex, type ScipIndex } from './scip.ts';

/** RAW java oracle: scip-java runs mvn/gradle internally and writes repo/index.scip.
 *  extraArgs appends build-tool args (e.g. "-Pandroid" for guava's android module,
 *  which the default maven reactor skips — the oracle's blind zone). */
export function oracleJavaRaw(javaBin: string, repo: string, runFn: Run, extraArgs: string[]): ScipIndex {
  const args = extraArgs.length > 0 ? ['index', '--', '--batch-mode', 'clean', 'verify', '-DskipTests', ...extraArgs] : ['index'];
  const r = runFn(javaBin, args, repo);
  if (!r.ok) throw new Error(`scip-java failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  const idx = join(repo, 'index.scip');
  const index = decodeScipIndex(javaBin, repo, runFn, idx);
  rmSync(idx, { force: true }); // scip-java writes into the repo — don't leave artifacts (mtime fingerprint)
  return index;
}

/** slashed FQN path → defining file (non-test, non-target preference). */
export function edgesFromJava(index: ScipIndex, repo: string): ParsedOracle {
  const symbolFile = new Map<string, string>();
  const fqnOf = (sym: string): string | null => {
    const m = sym.match(/^scip-java maven [^ ]+ [^ ]+ ([^#.()]+)/);
    return m ? m[1].replace(/\//g, '.') : null; // com/google/x → com.google.x
  };
  for (const doc of index.documents ?? []) {
    const p = rel(repo, doc.relative_path);
    if (p.startsWith('..') || p.includes('/target/')) continue;
    for (const o of doc.occurrences ?? []) {
      if ((o.symbol_roles ?? o.symbolRoles ?? 0) !== 1) continue; // definitions only
      const fqn = fqnOf(o.symbol);
      if (!fqn) continue;
      const existing = symbolFile.get(fqn);
      if (existing === undefined || (existing.includes('_test.') && !p.includes('_test.'))) symbolFile.set(fqn, p);
    }
  }
  const edges = new Set<string>();
  const fromFiles = new Set<string>();
  for (const doc of index.documents ?? []) {
    const from = rel(repo, doc.relative_path);
    if (from.startsWith('..') || /(^|\/)target\//.test(from)) continue;
    fromFiles.add(from);
    let src: string;
    try {
      src = readFileSync(join(repo, from), 'utf8');
    } catch {
      continue;
    }
    const imports = [...src.matchAll(/^\s*import\s+(?:static\s+)?([\w.$]+)\s*;/gm)].map((m) => m[1]);
    for (const imp of imports) {
      // exact FQN, then progressively shorter prefixes (inner-class imports address
      // the OUTER class file — same walk as cells' resolver).
      let f = imp;
      for (;;) {
        const to = symbolFile.get(f);
        if (to && to !== from) {
          edges.add(`${from}\0${to}`);
          break;
        }
        const i = f.lastIndexOf('.');
        if (i <= 0) break;
        f = f.slice(0, i);
      }
    }
  }
  return { edges, fromFiles };
}
