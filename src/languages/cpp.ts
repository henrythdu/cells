import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- AST → include paths ---

/** A `#include` directive: the literal target (quotes/angle stripped) + whether it was
 *  quoted (`"..."` — the author's own-code convention) or angle (`<...>` — the
 *  system/third-party convention). The split drives classification: a quoted miss is a
 *  broken local include (flagged), an angle miss is external (silent — stdlib). */
export interface CppInclude {
  path: string;
  quoted: boolean;
}

/** Include paths declared in a C/C++ file. preproc_include → string_literal (quoted) or
 *  system_lib_string (angle); both carry the literal target as their text (with quotes/<>
 *  — stripped by slice). Macro includes (`#include HEADER`) and `#include_next` have no
 *  literal child → skipped (statically unanalyzable; glibc internals). */
function extractIncludes(root: Node): CppInclude[] {
  const out: CppInclude[] = [];
  collectIncludes(root, out);
  return out;
}

function collectIncludes(node: Node, out: CppInclude[]): void {
  if (node.type === 'preproc_include') {
    const lit = node.namedChildren.find((c) => c.type === 'string_literal' || c.type === 'system_lib_string');
    const text = lit?.text;
    if (text && text.length >= 2) out.push({ path: text.slice(1, -1), quoted: lit.type === 'string_literal' });
    return;
  }
  for (const child of node.namedChildren) collectIncludes(child, out);
}

// --- resolution: include + importer file → target (via the census) ---

/** Code-bearing top-level dirs of the census ('.' first) — candidate `-I` roots. Derived
 *  from the census itself, not build-system reads: every top-level dir that contains code is
 *  a potential include root (include/, src/, lib/, external/, vendor/… — fmt's `-I include`
 *  layout makes `#include "fmt/format.h"` resolve to include/fmt/format.h). Sorted for
 *  determinism. Root-level files are covered by the '.' probe. */
export function includeRoots(files: ReadonlySet<string>): string[] {
  const dirs = new Set<string>();
  for (const p of files) {
    const i = p.indexOf('/');
    if (i !== -1) dirs.add(p.slice(0, i));
  }
  return ['.', ...[...dirs].sort()];
}

/** includeRoots, memoized per census set. resolveEdges runs once per file with the SAME ctx
 *  (same Set identity) — recomputing the top-level scan per file would be O(files²) on big
 *  C++ repos. WeakMap: the Set dies with the extract, no cross-run staleness (the factory
 *  builds a fresh Set every extract). */
const rootsCache = new WeakMap<ReadonlySet<string>, string[]>();
function includeRootsCached(files: ReadonlySet<string>): string[] {
  let cached = rootsCache.get(files);
  if (!cached) {
    cached = includeRoots(files);
    rootsCache.set(files, cached);
  }
  return cached;
}

/** cpp-family census paths, shortest-first (then alpha) — the suffix-match candidate order.
 *  Derived from the importer's own module→file map (keys are paths — identity keys).
 *  Memoized per map like includeRootsCached. */
const cppFilesCache = new WeakMap<Map<string, string>, string[]>();
function sortedCppFiles(moduleToFile: Map<string, string>): string[] {
  let cached = cppFilesCache.get(moduleToFile);
  if (!cached) {
    cached = [...moduleToFile.keys()].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    cppFilesCache.set(moduleToFile, cached);
  }
  return cached;
}

/** Suffix-match fallback: an include no probe reached but that SOME census file ends with —
 *  a header found via a DEEP `-I` root (llama ggml/include, pandas _libs/include — stress
 *  bug #12; the grilled probes cover only top-level roots). Any hit here is a file the build
 *  could compile against in some -I config. Deterministic: shortest path first, then alpha.
 *  Probes already exhausted the standard locations, so a root-level/same-dir twin would have
 *  won there — the fallback only ever fires on -I-rooted files.
 *  Leading `../` segments are stripped (bug #13): `../include/ggml-cann.h` from
 *  ggml/src/ggml-cann/ is `-I ggml/include` + the relative prefix — the meaningful part for
 *  a suffix scan is `include/ggml-cann.h`; the `..`s cancel inside the root and are
 *  meaningless to a bare path scan. The include is normalized first (`.`/`..` segments
 *  resolve — ocr MEDIUM), then stripped; census paths never contain `.`/`..` segments, so
 *  the raw form can never match. */
function suffixMatch(include: string, files: readonly string[]): string | undefined {
  const target = `/${posix.normalize(include).replace(/^(\.\.\/)+/, '')}`;
  return files.find((p) => p.endsWith(target));
}

/** Candidate targets for an include, in probe order:
 *  1. importer-dir-relative (quoted only — the C standard: `"..."` first searches the
 *     including file's directory; `../`/`./` segments normalize away),
 *  2. repo-relative against every code-bearing top-level dir (both forms — the flattened
 *     `-I` approximation: headers addressed bare or under an include/ src/ lib/ root).
 *  Escapes above the repo root drop out (can't be in the census). Pure over the file
 *  set — no FS chasing. */
export function includeCandidates(inc: CppInclude, sourcePath: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  if (inc.quoted) {
    const dir = posix.dirname(sourcePath);
    const rel = posix.normalize(inc.path);
    const fromDir = dir === '.' ? rel : posix.normalize(`${dir}/${rel}`);
    if (!fromDir.startsWith('..') && fromDir !== '.') out.push(fromDir);
  }
  const clean = posix.normalize(inc.path);
  if (clean !== '.') {
    for (const root of roots) {
      // Join + normalize per root, drop only if the RESULT escapes the repo. `..`-relative
      // includes (bug #13) are NOT pre-dropped: `-I src` + `../src/x.h` = `src/../src/x.h`
      // → `src/x.h` — a valid in-repo target the importer-dir probe (a different dir)
      // can't reach. Only escapes (`../../out.h` from `src/`) drop.
      const probe = root === '.' ? clean : posix.normalize(`${root}/${clean}`);
      if (!probe.startsWith('..') && probe !== '.') out.push(probe);
    }
  }
  return [...new Set(out)];
}

/** C++ has no package/module concept — every file is its own unit, so the module key is
 *  the file's path itself (identity). The census map then holds path→path, and resolution
 *  probes it by candidate path. */
const fileToModule = (path: string): string => path;

/** C/C++ importer — tree-sitter analysis + include→file resolution via the census. Quoted
 *  includes are local by definition (missing → unresolved, the LLM's problem); angle
 *  includes are external unless a census hit proves them owned. No build system, no -I
 *  reads — source-based only (design philosophy).
 *  ponytail: -I roots = top-level code dirs only (census-derived). The suffix fallback covers
 *  DEEPER roots (ggml/include, pandas _libs/include, vendored gtest at test/gtest/…), but a
 *  header whose suffix appears nowhere in the census — or whose every suffix twin lives under
 *  a non-top-level root the probes never reached (ambiguous common names like config.h) —
 *  stays unresolved; shortest-first picks deterministically when several twins exist. */
export const cppImporter = createTreeSitterImporter<CppInclude[]>({
  name: 'cpp',
  extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  wasmBasename: 'tree-sitter-cpp.wasm',
  fileToModule,
  analyze: (root) => ({
    mods: [],
    reexports: [],
    uses: extractIncludes(root),
  }),
  resolveEdges: (includes, sourcePath, _importerModule, ctx) => {
    const roots = includeRootsCached(ctx.files); // stable across this file's includes, memoized per census
    const cppFiles = sortedCppFiles(ctx.moduleToFile); // suffix-match candidates, shortest-first
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const inc of includes) {
      const target = includeCandidates(inc, sourcePath, roots).find((c) => ctx.files.has(c)) ?? suffixMatch(inc.path, cppFiles);
      if (target) {
        if (target !== sourcePath) edges.push({ fromFile: sourcePath, toFile: target, import: inc.path });
      } else if (inc.quoted) {
        unresolved.push({ fromFile: sourcePath, import: inc.path });
      }
    }
    return { edges, unresolved };
  },
});
