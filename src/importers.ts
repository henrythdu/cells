import { extname } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import type { ImportEdge } from './crossings.js';
import type { Ownership } from './ownership.js';
import { loadConfig, loadOwnership, listCodeFiles, readFiles } from './io.js';

/** A source file with its content — the unit importers parse. */
export interface SourceFile {
  path: string;
  content: string;
}

/** Context handed to every importer. */
export interface ImportContext {
  codeDirs: string[];
  files: SourceFile[];
  ownership: Ownership;
}

/**
 * An importer extracts file→file import edges for a set of file extensions.
 * One per language; selection is automatic by extension. TS/JS uses dep-cruiser
 * (already best-in-class); other languages use tree-sitter. Resolving an import
 * to a file may use `ownership` (e.g. Python derives a module→file map from it)
 * rather than filesystem heuristics — landing on a cell via ownership, not by
 * competing with the IDE on file resolution.
 */
export interface Importer {
  /** Extensions this importer handles, e.g. ['.ts', '.tsx']. */
  extensions: readonly string[];
  /** If true, the importer needs file *contents* (not just paths). */
  needsContent?: boolean;
  /** Extract file→file edges. Pure wrt its inputs (may read the FS via a lib). */
  extract(ctx: ImportContext): Promise<ImportEdge[]>;
}

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

// Python importer lives in ./python.js (tree-sitter extraction + module→file resolution via ownership).
import { pythonImporter } from './python.js';
export { pythonImporter };

/** Default importer registry (add a language = add an importer here). */
export const DEFAULT_IMPORTERS: readonly Importer[] = [depCruiserImporter, pythonImporter];

/** Which importers run for the given extensions. Pure — unit-testable. */
export function selectImporters(exts: readonly string[], importers: readonly Importer[]): Importer[] {
  const present = new Set(exts);
  return importers.filter((imp) => imp.extensions.some((e) => present.has(e)));
}

/**
 * Collect raw file→file import edges by dispatching to importers by extension.
 * The only language-coupled seam in Cells; everything downstream consumes ImportEdge[].
 */
export async function collectImportEdges(): Promise<ImportEdge[]> {
  const { codeDirs } = loadConfig();
  const ownership = loadOwnership();
  const paths = listCodeFiles();
  const exts = Array.from(new Set(paths.map((p) => extname(p))));
  const selected = selectImporters(exts, DEFAULT_IMPORTERS);
  let files: SourceFile[];
  if (selected.some((i) => i.needsContent)) {
    const contents = readFiles(paths);
    files = paths.map((p) => ({ path: p, content: contents[p] ?? '' }));
  } else {
    files = paths.map((p) => ({ path: p, content: '' }));
  }
  const edges: ImportEdge[] = [];
  for (const imp of selected) {
    edges.push(...(await imp.extract({ codeDirs, files, ownership })));
  }
  return edges;
}
