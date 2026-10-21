import { extname, join } from 'node:path';
import { applyBridges, buildBridgeMap } from './bridges.js';
import type { ImportContext, ImportEdge, Importer, SourceFile, UnresolvedImport } from './imports.js';
import { listCodeFiles, loadConfig, readFiles } from './io.js';
import { cppImporter } from './languages/cpp.js';
import { goImporter } from './languages/go.js';
import { javaImporter } from './languages/java.js';
import { pythonImporter } from './languages/python.js';
import { rustImporter } from './languages/rust.js';
// The language importer specs live in `./languages/`. To add a language, add a spec file
// there and one `LANGUAGES` row below. The spec file uses the `Importer` interface and the
// `createTreeSitterImporter` factory for tree-sitter languages, or a custom extract for
// other languages. At build time, `scripts/build-manifest.mjs` derives
// `grammars/manifest.json` from the same table, so there is no second list to drift.
import { javascriptImporter, tsxImporter, typescriptImporter } from './languages/typescript.js';

// This module re-exports the grammar-bundle integrity check. `commands/health` reaches the
// language machinery only through this hub, which is the declared single seam for all
// language code.
export { checkGrammars } from './languages/tree-sitter.js';

/** The single language registry, with one row per language: the importer and its bundled
 *  grammar WASM file. `DEFAULT_IMPORTERS` derives from this table. The packaged manifest
 *  (`grammars/manifest.json`) is generated from this table at build time
 *  (`scripts/build-manifest.mjs`). To add a language, add one row here and the spec file. */
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

/** The default importer registry. It derives from `LANGUAGES` and is never maintained by
 *  hand. */
export const DEFAULT_IMPORTERS: readonly Importer[] = LANGUAGES.map((l) => l.importer);

/** Select the importers that run for the given extensions. The function is pure, so a unit
 *  test can check it. */
export function selectImporters(exts: readonly string[], importers: readonly Importer[]): Importer[] {
  const present = new Set(exts);
  return importers.filter((imp) => imp.extensions.some((e) => present.has(e)));
}

/** Find the extensions in the census that no importer handles. A non-empty result means
 *  that the crossings graph is blind for those files, so `crossings`, `impact`, `structure`,
 *  and `graph` stay unverified. The result is sorted and deduplicated. The function is pure,
 *  so a unit test can check it. */
export function uncoveredImporterExts(exts: readonly string[], importers: readonly Importer[]): string[] {
  const covered = new Set(importers.flatMap((i) => i.extensions));
  return [...new Set(exts)].filter((e) => !covered.has(e)).sort();
}

/** Return the subset of detected extensions that cells can analyze. This function is the
 *  inverse of `uncoveredImporterExts`, and it preserves the input order. `cells init` uses
 *  it, so the configuration of a repository does not ship blind extensions, such as a lone
 *  `.h` fixture, that would warn forever. The function is pure, so a unit test can check
 *  it. */
export function importableExts(exts: readonly string[], importers: readonly Importer[]): string[] {
  const covered = new Set(importers.flatMap((i) => i.extensions));
  return exts.filter((e) => covered.has(e));
}

/**
 * Collect the raw import edges from file to file. The function dispatches to importers by
 * file extension. This function is the only language-coupled seam in Cells, and every
 * consumer downstream reads `ImportEdge[]`.
 *
 * The function also returns the unresolved local imports. These are diagnostics: imports
 * that look local, but that resolve to no file.
 *
 * The dispatch is sequential. The shared WASM state of web-tree-sitter races when two
 * grammars load at the same time, and the race produces silent empty results. Importer
 * failures appear in `failures` and are never swallowed, because a zero-edge result on a
 * blind graph must not fake a passing gate.
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
  // Read the content only on demand. Without `needsContent`, no importer reads the body of
  // a file, so skip the disk read. A census without content avoids reading every file for
  // nothing.
  const contents = selected.some((i) => i.needsContent) ? readFiles(paths, baseDir) : {};
  const files: SourceFile[] = paths.map((p) => ({ path: p, content: contents[p] ?? '' }));
  // Tree-sitter reads `files`. Point both at `baseDir`, so the code can derive a HEAD tree
  // for `crossings --diff`. The `.cells/` directory stays in the working repository.
  const dirs = codeDirs.map((d) => join(baseDir, d));
  const ctx: ImportContext = { codeDirs: dirs, files, baseDir, moduleRoot }; // The typed contract. A drift between this construction and the shape of `Importer.extract` fails here.
  const edges: ImportEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const failures: ImporterFailure[] = [];
  // Sequential dispatch. See the doc comment: grammar loads that run at the same time race
  // the shared WASM state.
  for (const imp of selected) {
    try {
      const result = await imp.extract(ctx);
      // A `push()` with a spread would overflow the call stack on a large graph, because a
      // 300k-edge extract becomes 300k spread arguments and a RangeError. Java on
      // elasticsearch hit this problem, so use a loop.
      for (const e of result.edges) edges.push(e);
      for (const u of result.unresolved) unresolved.push(u);
    } catch (err) {
      failures.push({ importer: imp.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Bridge crossings (ADR 0001). FFI extension-module imports (pyo3) that came back
  // unresolved resolve to the entry file of the binding crate. The resolution comes from a
  // declaration, so it needs no per-repository configuration. An empty map (no cdylib
  // crates) means that the behavior does not change.
  const bridged = applyBridges(buildBridgeMap(codeDirs, baseDir), unresolved, new Set(paths), baseDir);
  for (const e of bridged.edges) edges.push(e); // A loop, not a spread. The same rule as above.
  return { edges, uncoveredExts, unresolved: bridged.unresolved, failures, ignoreBlindExts: config.ignoreBlindExts };
}

/** An importer that failed to extract. The edges of its language are missing, so the graph
 *  is blind for that language. */
export interface ImporterFailure {
  importer: string;
  error: string;
}
