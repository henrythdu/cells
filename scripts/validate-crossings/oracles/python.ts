/** python oracle — pyright --dependencies --verbose prints the TRUE import
 *  graph (per file: " Imports N files" + file:// URIs, only with --verbose).
 *  scip-python was tried first — it emits every symbol reference (usage refs
 *  like `self.json.dumps`), and its import refs carry shortened module symbols
 *  that can't be matched to defs in src-layouts. pyright's deps output IS the
 *  import graph. Cached as raw text. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedOracle } from '../compare.ts';
import type { Run } from '../shared.ts';
import { rel } from '../shared.ts';

/** RAW python oracle: run pyright with the repo's code-dirs (default src, test). */
export function oraclePythonRaw(repo: string, runFn: Run, pyrightBin: string): string {
  let dirs = ['src', 'test'];
  try {
    const cfg = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    const m = cfg.match(/^code-dirs\s*=\s*\[([^\]]*)\]/m);
    if (m) {
      const parsed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      if (parsed.length > 0) dirs = parsed;
    }
  } catch {
    /* default code-dirs */
  }
  const r = runFn(pyrightBin, ['--verbose', '--dependencies', ...dirs], repo);
  // pyright exits nonzero when it finds type errors — the deps output is still complete.
  if (!r.stdout.includes(' Imports ')) throw new Error(`pyright --dependencies failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return r.stdout;
}

/** Parse pyright --dependencies --verbose output into file→file edges. Sections:
 *  <relpath> / " Imports N files" (file:// URIs, verbose) / " Imported by N files"
 *  (file:// URIs — the REVERSE graph, must not be collected). Noise lines
 *  (config, "Found N source files", diagnostics) match none of the patterns. */
export function oraclePythonFromRaw(stdout: string, repo: string): ParsedOracle {
  const edges = new Set<string>();
  const fromFiles = new Set<string>();
  let cur: string | null = null;
  let inImports = false;
  for (const line of stdout.split('\n')) {
    if (/^ Imports\s+\d+ file/.test(line)) {
      inImports = true;
      continue;
    }
    if (/^ Imported by/.test(line)) {
      inImports = false; // reverse-graph section — stop collecting
      continue;
    }
    if (/^\S.*\.pyi?$/.test(line) && !line.startsWith('file://')) {
      const h = rel(repo, line); // headers are repo-relative when pyright gets a config, absolute with positional dirs
      if (h.startsWith('..')) {
        cur = null; // outside the repo (e.g. the pip-installed copy in site-packages)
        inImports = false;
        continue;
      }
      cur = h; // section header
      fromFiles.add(h);
      inImports = false;
      continue;
    }
    if (cur && inImports && /^ {4}file:\/\//.test(line)) {
      const to = rel(repo, line.trim().slice('file://'.length));
      if (!to.startsWith('..') && to !== cur) edges.add(`${cur}\0${to}`);
    }
  }
  return { edges, fromFiles };
}
