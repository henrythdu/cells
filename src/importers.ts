import { extname, join } from 'node:path';
import type { ImportEdge, SourceFile, UnresolvedImport, Importer } from './imports.js';
import { loadConfig, loadOwnership, listCodeFiles, readFiles } from './io.js';

// Language importer specs live in ./languages/ — add a language = add a spec file there
// (the seam: Importer interface + createTreeSitterImporter factory for tree-sitter langs,
// a custom extract for others) + one line in DEFAULT_IMPORTERS below.
import { depCruiserImporter } from './languages/typescript.js';
import { pythonImporter } from './languages/python.js';
import { rustImporter } from './languages/rust.js';
// The grammar-bundle integrity check re-exported here: commands/health reaches the language
// machinery ONLY through this hub (the declared single seam for "everything language").
export { checkGrammars } from './languages/tree-sitter.js';
export { depCruiserImporter, pythonImporter, rustImporter };

/** Default importer registry (add a language = add an importer here). */
export const DEFAULT_IMPORTERS: readonly Importer[] = [depCruiserImporter, pythonImporter, rustImporter];

/** Which importers run for the given extensions. Pure — unit-testable. */
export function selectImporters(exts: readonly string[], importers: readonly Importer[]): Importer[] {
  const present = new Set(exts);
  return importers.filter((imp) => imp.extensions.some((e) => present.has(e)));
}

/** Extensions present in the census that NO importer handles. Non-empty means the
 * crossings graph is BLIND for those files — crossings/impact/structure/graph are
 * unverified. Sorted + deduped. Pure — unit-testable. */
export function uncoveredImporterExts(exts: readonly string[], importers: readonly Importer[]): string[] {
  const covered = new Set(importers.flatMap((i) => i.extensions));
  return [...new Set(exts)].filter((e) => !covered.has(e)).sort();
}

/**
 * Collect raw file→file import edges by dispatching to importers by extension.
 * The only language-coupled seam in Cells; everything downstream consumes ImportEdge[].
 * Also returns unresolved local imports (diagnostics — imports that look local but resolved to no file).
 * Sequential dispatch: web-tree-sitter's shared WASM state races when two grammars load
 * concurrently (silent empty results — see headroom P0). Importer failures are surfaced
 * in `failures`, never swallowed — a zero-edge result on a blind graph must not fake green.
 */
export async function collectImportEdges(
  baseDir = '.',
  importers: readonly Importer[] = DEFAULT_IMPORTERS,
): Promise<{
  edges: ImportEdge[];
  uncoveredExts: string[];
  unresolved: UnresolvedImport[];
  failures: ImporterFailure[];
  ignoreBlindExts: string[];
}> {
  const config = loadConfig();
  const { codeDirs, moduleRoot } = config;
  const ownership = loadOwnership();
  const paths = listCodeFiles(baseDir);
  const exts = Array.from(new Set(paths.map((p) => extname(p))));
  const selected = selectImporters(exts, importers);
  const uncoveredExts = uncoveredImporterExts(exts, importers);
  let files: SourceFile[];
  if (selected.some((i) => i.needsContent)) {
    const contents = readFiles(paths, baseDir);
    files = paths.map((p) => ({ path: p, content: contents[p] ?? '' }));
  } else {
    files = paths.map((p) => ({ path: p, content: '' }));
  }
  // dep-cruiser cruises dirs (FS); tree-sitter reads `files`. Point both at `baseDir` so a
  // HEAD tree can be derived for `crossings --diff`. `.cells/` stays in the working repo.
  const dirs = codeDirs.map((d) => join(baseDir, d));
  const ctx = { codeDirs: dirs, files, ownership, baseDir, moduleRoot };
  const edges: ImportEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const failures: ImporterFailure[] = [];
  // Sequential, not Promise.all: two tree-sitter grammars loading concurrently race
  // web-tree-sitter's shared WASM state → one importer silently returns empty.
  for (const imp of selected) {
    try {
      const result = await imp.extract(ctx);
      edges.push(...result.edges);
      unresolved.push(...result.unresolved);
    } catch (err) {
      failures.push({ importer: imp.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { edges, uncoveredExts, unresolved, failures, ignoreBlindExts: config.ignoreBlindExts };
}

/** An importer that failed to extract — its language's edges are missing, the graph is blind for it. */
export interface ImporterFailure {
  importer: string;
  error: string;
}
