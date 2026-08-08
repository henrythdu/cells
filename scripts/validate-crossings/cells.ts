/** The cells side of the audit: run `cells imports --json` and shape it into
 *  the same edge set + unresolved map the compare pass consumes. */

import type { Run } from './shared.ts';

export interface CellsEdges {
  edges: Set<string>; // `${fromFile}\0${toFile}`
  unresolved: Map<string, { fromFile: string; import: string }>;
}

export function cellsEdges(cellsBin: string, repo: string, runFn: Run): CellsEdges {
  const r = runFn(process.execPath, [cellsBin, 'imports', '--json'], repo);
  if (!r.ok) throw new Error(`cells imports --json failed: ${r.stderr.slice(0, 600)}`);
  let data: { edges: { fromFile: string; toFile: string }[]; unresolved: { fromFile: string; import: string }[] };
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error(`cells imports --json produced no JSON: ${r.stdout.slice(0, 200)}`);
  }
  const edges = new Set(data.edges.map((e) => `${e.fromFile}\0${e.toFile}`));
  const unresolved = new Map(data.unresolved.map((u) => [`${u.fromFile}\0${u.import}`, u]));
  return { edges, unresolved };
}
