/** SCIP shared oracle — decode an index, extract file→file edges. Used by the
 *  rust/go (and originally cpp/python) oracles; each indexer's symbol
 *  vocabulary decides which refs are IMPORTS:
 *    go:     package/module symbols (trailing '/') — a file can name a
 *            package only via an import statement; value refs are uses.
 *    python: module symbols (trailing '/__init__:') — pyright-scip emits
 *            EVERY symbol reference (e.g. `self.json.dumps` refs the
 *            DefaultJSONProvider class); imports are the only module-symbol
 *            refs.
 *    rust:   all non-local refs (no distinguishing convention). */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../shared.ts';
import { rel } from '../shared.ts';

interface ScipDoc {
  relative_path: string;
  occurrences?: { symbol: string; symbol_roles?: number; symbolRoles?: number }[];
}
export interface ScipIndex {
  documents?: ScipDoc[];
}

/** Run the scip CLI to decode an index file into JSON (the shared RAW artifact). */
export function decodeScipIndex(scipBin: string, repo: string, runFn: Run, file: string): ScipIndex {
  const dec = runFn(scipBin, ['print', '--json', file], repo);
  if (!dec.ok) throw new Error(`scip print failed: ${dec.stderr.slice(0, 400)}`);
  try {
    return JSON.parse(dec.stdout);
  } catch {
    throw new Error(`scip print produced no JSON (index corrupt or empty): ${dec.stdout.slice(0, 200)}`);
  }
}

/** RAW scip oracle: run the indexer, return the DECODED index (cached as-is). */
export function oracleScipRaw(probe: string, buildArgs: (scipFile: string) => string[], scipBin: string, repo: string, runFn: Run): ScipIndex {
  const tmp = mkdtempSync(join(tmpdir(), 'vc-scip-'));
  const scipFile = join(tmp, 'index.scip');
  const r = runFn(probe, buildArgs(scipFile), repo);
  if (!r.ok) {
    const err = r.stderr.slice(0, 600) || r.stdout.slice(0, 600);
    throw new Error(`${probe} failed: ${err}`);
  }
  return decodeScipIndex(scipBin, repo, runFn, scipFile);
}

/** Extract file→file edges from a SCIP index (symbol→file map from role-1
 *  definition occurrences; every non-definition occurrence in file F whose
 *  symbol is defined in the same module → edge F→thatFile). */
export function edgesFromIndex(index: ScipIndex, repo: string, symbolKeep?: (symbol: string) => boolean): Set<string> {
  const keepRef = symbolKeep ?? (() => true);
  // symbol → defining file (role 1 = definition). RA uses file-scoped `local N`
  // symbols (same name in every file) — they must never cross files. Go package
  // symbols are defined in EVERY file of the package — prefer the non-test def
  // (last-write-wins would land on *_test.go and mispoint every reference).
  const symbolFile = new Map<string, string>();
  for (const doc of index.documents ?? []) {
    const p = rel(repo, doc.relative_path);
    if (p.startsWith('..')) continue;
    for (const o of doc.occurrences ?? []) {
      if (o.symbol.startsWith('local ')) continue;
      if (o.symbol_roles === 1 || o.symbolRoles === 1) {
        const existing = symbolFile.get(o.symbol);
        if (existing === undefined || (existing.endsWith('_test.go') && !p.endsWith('_test.go'))) {
          symbolFile.set(o.symbol, p);
        }
      }
    }
  }

  const edges = new Set<string>();
  for (const doc of index.documents ?? []) {
    const from = rel(repo, doc.relative_path);
    if (from.startsWith('..')) continue;
    for (const o of doc.occurrences ?? []) {
      if (o.symbol.startsWith('local ')) continue;
      const role = o.symbol_roles ?? o.symbolRoles ?? 0;
      if (role === 1) continue; // definitions are not edges
      if (!keepRef(o.symbol)) continue; // only import-carrying refs for this indexer
      const to = symbolFile.get(o.symbol);
      if (to && to !== from) edges.add(`${from}\0${to}`);
    }
  }
  return edges;
}
