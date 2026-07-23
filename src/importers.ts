import { extname } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import type { ImportEdge, SourceFile, Importer } from './crossings.js';
import { loadConfig, loadOwnership, listCodeFiles, readFiles } from './io.js';

/** dep-cruiser importer — TS/JS. Source-based; handles aliases and `.js`→`.ts`. */
export const depCruiserImporter: Importer = {
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
  async extract({ codeDirs }): Promise<ImportEdge[]> {
    const dirs = codeDirs.map((d) => (d.endsWith('/') ? d : `${d}/`));
    let result: ICruiseResult;
    try {
      const { output } = await cruise(dirs, {
        tsPreCompilationDeps: true,
        doNotFollow: { path: 'node_modules' },
      });
      result = output as ICruiseResult;
    } catch {
      return []; // dep-cruiser couldn't handle the paths/language — no edges.
    }
    const norm = (p: string): string => p.replace(/^\.\//, '');
    const edges: ImportEdge[] = [];
    for (const mod of result.modules ?? []) {
      for (const dep of mod.dependencies ?? []) {
        if (dep.couldNotResolve || dep.coreModule) continue; // external / node built-in
        if (!dep.resolved) continue;
        edges.push({ fromFile: norm(mod.source), toFile: norm(dep.resolved), import: dep.module });
      }
    }
    return edges;
  },
};

// Python importer lives in ./python.js; Rust importer in ./rust.js (tree-sitter extraction + module→file resolution via ownership).
import { pythonImporter } from './python.js';
import { rustImporter } from './rust.js';
export { pythonImporter, rustImporter };

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
 */
export async function collectImportEdges(): Promise<{ edges: ImportEdge[]; uncoveredExts: string[] }> {
  const { codeDirs } = loadConfig();
  const ownership = loadOwnership();
  const paths = listCodeFiles();
  const exts = Array.from(new Set(paths.map((p) => extname(p))));
  const selected = selectImporters(exts, DEFAULT_IMPORTERS);
  const uncoveredExts = uncoveredImporterExts(exts, DEFAULT_IMPORTERS);
  let files: SourceFile[];
  if (selected.some((i) => i.needsContent)) {
    const contents = readFiles(paths);
    files = paths.map((p) => ({ path: p, content: contents[p] ?? '' }));
  } else {
    files = paths.map((p) => ({ path: p, content: '' }));
  }
  // Run importers concurrently; each is independent (disjoint extensions). One importer's
  // failure degrades to no edges rather than aborting the whole collection.
  const results = await Promise.all(
    selected.map((imp) => imp.extract({ codeDirs, files, ownership }).catch(() => [])),
  );
  const edges: ImportEdge[] = [];
  for (const result of results) edges.push(...result);
  return { edges, uncoveredExts };
}
