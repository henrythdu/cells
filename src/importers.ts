import { extname, join } from 'node:path';
import { applyBridges, buildBridgeMap } from './bridges.js';
import type { ImportEdge, Importer, SourceFile, UnresolvedImport } from './imports.js';
import { listCodeFiles, loadConfig, readFiles } from './io.js';
import { cppImporter } from './languages/cpp.js';
import { goImporter } from './languages/go.js';
import { javaImporter } from './languages/java.js';
import { pythonImporter } from './languages/python.js';
import { rustImporter } from './languages/rust.js';
// Language importer specs live in ./languages/ — add a language = add a spec file there
// (the seam: Importer interface + createTreeSitterImporter factory for tree-sitter langs,
// a custom extract for others) + one LANGUAGES row below (scripts/build-manifest.mjs
// derives grammars/manifest.json from the same table at build — no second list to drift).
import { javascriptImporter, tsxImporter, typescriptImporter } from './languages/typescript.js';

// The grammar-bundle integrity check re-exported here: commands/health reaches the language
// machinery ONLY through this hub (the declared single seam for "everything language").
export { checkGrammars } from './languages/tree-sitter.js';
export { cppImporter, goImporter, javaImporter, javascriptImporter, pythonImporter, rustImporter, tsxImporter, typescriptImporter };

/** The single language registry: one row per language — the importer + its bundled
 *  grammar WASM. DEFAULT_IMPORTERS derives from it, and the packaged manifest
 *  (grammars/manifest.json) is generated from it at build (scripts/build-manifest.mjs).
 *  Add a language = one row here (+ the spec file). */
export const LANGUAGES: readonly { importer: Importer; wasm: string }[] = [
  { importer: typescriptImporter, wasm: 'tree-sitter-typescript.wasm' },
  { importer: tsxImporter, wasm: 'tree-sitter-tsx.wasm' },
  { importer: javascriptImporter, wasm: 'tree-sitter-javascript.wasm' },
  { importer: pythonImporter, wasm: 'tree-sitter-python.wasm' },
  { importer: rustImporter, wasm: 'tree-sitter-rust.wasm' },
  { importer: goImporter, wasm: 'tree-sitter-go.wasm' },
  { importer: cppImporter, wasm: 'tree-sitter-cpp.wasm' },
  { importer: javaImporter, wasm: 'tree-sitter-java.wasm' },
];

/** Default importer registry — derived from LANGUAGES (never hand-maintained). */
export const DEFAULT_IMPORTERS: readonly Importer[] = LANGUAGES.map((l) => l.importer);

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

/** The subset of detected extensions cells can actually analyze (the inverse of
 *  uncoveredImporterExts, preserving input order). Used by `cells init` so a repo's
 *  config doesn't ship blind extensions (a lone .h fixture) that would warn forever.
 *  Pure — unit-testable. */
export function importableExts(exts: readonly string[], importers: readonly Importer[]): string[] {
  const covered = new Set(importers.flatMap((i) => i.extensions));
  return exts.filter((e) => covered.has(e));
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
  // Tree-sitter reads `files`; point both at `baseDir` so a HEAD tree can be derived
  // for `crossings --diff`. `.cells/` stays in the working repo.
  const dirs = codeDirs.map((d) => join(baseDir, d));
  const ctx = { codeDirs: dirs, files, baseDir, moduleRoot };
  const edges: ImportEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const failures: ImporterFailure[] = [];
  // Sequential, not Promise.all: two tree-sitter grammars loading concurrently race
  // web-tree-sitter's shared WASM state → one importer silently returns empty.
  for (const imp of selected) {
    try {
      const result = await imp.extract(ctx);
      // push() with a spread would overflow the call stack on large graphs (a 300k-edge
      // extract = 300k spread args → RangeError; java on elasticsearch hit it) — loop instead.
      for (const e of result.edges) edges.push(e);
      for (const u of result.unresolved) unresolved.push(u);
    } catch (err) {
      failures.push({ importer: imp.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Bridge crossings (ADR 0001): FFI extension-module imports (pyo3) that came back
  // unresolved resolve to the binding crate's entry file — declaration-derived, so no
  // per-repo config. Empty map (no cdylib crates) = zero behavior change.
  const bridged = applyBridges(buildBridgeMap(codeDirs, baseDir), unresolved, baseDir);
  edges.push(...bridged.edges);
  unresolved.length = 0;
  unresolved.push(...bridged.unresolved);
  return { edges, uncoveredExts, unresolved, failures, ignoreBlindExts: config.ignoreBlindExts };
}

/** An importer that failed to extract — its language's edges are missing, the graph is blind for it. */
export interface ImporterFailure {
  importer: string;
  error: string;
}
