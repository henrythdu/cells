import { extname, join, resolve, relative } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import type { ImportEdge, ImportResult, SourceFile, UnresolvedImport, Importer } from './imports.js';
import { loadConfig, loadOwnership, listCodeFiles, readFiles } from './io.js';

/** dep-cruiser importer — TS/JS. Source-based; handles aliases and `.js`→`.ts`. */
export const depCruiserImporter: Importer = {
  name: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
  async extract({ codeDirs, baseDir }): Promise<ImportResult> {
    const dirs = codeDirs.map((d) => (d.endsWith('/') ? d : `${d}/`));
    let result: ICruiseResult;
    try {
      const { output } = await cruise(dirs, {
        tsPreCompilationDeps: true,
        doNotFollow: { path: 'node_modules' },
      });
      result = output as ICruiseResult;
    } catch (err) {
      // dep-cruiser couldn't handle the paths/language — surface it; silent zero-edges
      // would fake a green gate on a blind graph. (collectImportEdges turns this into
      // a gate failure.)
      throw new Error(`dependency-cruiser failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // dep-cruiser emits paths relative to cwd; when cruising a HEAD tree (baseDir) remap them
    // to repo-relative so they match ownership. (Tree-sitter importers already emit repo-relative.)
    const cwd = process.cwd();
    const norm = (p: string): string => {
      const n = p.replace(/^\.\//, '');
      return baseDir && baseDir !== '.' ? relative(baseDir, resolve(cwd, n)) : n;
    };
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const mod of result.modules ?? []) {
      for (const dep of mod.dependencies ?? []) {
        if (dep.couldNotResolve) {
          // Relative specifiers that can't resolve look local — likely a broken import.
          // Bare specifiers (e.g. 'react') are external packages — skip silently.
          if (dep.module.startsWith('.')) unresolved.push({ fromFile: norm(mod.source), import: dep.module });
          continue;
        }
        if (dep.coreModule) continue; // node built-in
        if (!dep.resolved) continue;
        edges.push({
          fromFile: norm(mod.source),
          toFile: norm(dep.resolved),
          import: dep.module,
        });
      }
    }
    return { edges, unresolved };
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
