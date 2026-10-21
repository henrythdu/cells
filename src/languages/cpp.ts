import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, memoizeWeak } from './tree-sitter.js';

// --- From the AST to the include paths ---

/** A `#include` directive: the literal target with the quotes or angle brackets stripped,
 *  and a flag that says whether the author used quotes (`"..."`) or angle brackets
 *  (`<...>`). The quote convention marks the author's own code, and the angle convention
 *  marks system or third-party code. The split drives the classification: a quoted include
 *  that misses is a broken local include and is flagged, and an angle include that misses is
 *  external and silent, because it is probably a standard library header. */
export interface CppInclude {
  path: string;
  quoted: boolean;
}

/** Return the include paths that a C or C++ file declares. The tree is preproc_include, then
 *  string_literal for a quoted include, or preproc_include, then system_lib_string for an angle
 *  include. Both nodes carry the literal target as their text, including the quotes or
 *  brackets, which the code strips with `slice`. A macro include (`#include HEADER`) and
 *  `#include_next` have no literal child, so the function skips them: they cannot be
 *  analyzed statically, and they come from internals of glibc. */
function extractIncludes(root: Node): CppInclude[] {
  const out: CppInclude[] = [];
  collectIncludes(root, out);
  return out;
}

function collectIncludes(node: Node, out: CppInclude[]): void {
  if (node.type === 'preproc_include') {
    const lit = node.namedChildren.find((c) => c.type === 'string_literal' || c.type === 'system_lib_string');
    const text = lit?.text;
    // Translate a backslash separator here, one time. An include written on Windows uses
    // `lib\x.h`, and every census path uses `/`, so an untranslated literal can never match a
    // real file and the include reads as broken.
    if (text && text.length >= 2) out.push({ path: text.slice(1, -1).replace(/\\/g, '/'), quoted: lit.type === 'string_literal' });
    return;
  }
  for (const child of node.namedChildren) collectIncludes(child, out);
}

// --- Resolution: from an include and the importer file to a target, through the census ---

/** Return the top-level code directories of the census, with `.` first. These directories
 *  are the candidate roots for the `-I` option of the compiler.
 *
 *  The function derives the roots from the census and does not read a build system. Every
 *  top-level directory that contains code is a potential include root: `include/`, `src/`,
 *  `lib/`, `external/`, `vendor/`, and others. The layout of fmt uses `-I include`, so
 *  `#include "fmt/format.h"` resolves to `include/fmt/format.h`. The result is sorted, so it
 *  is deterministic. The `.` probe covers the files at the root level. */
export function includeRoots(files: ReadonlySet<string>): string[] {
  const dirs = new Set<string>();
  for (const p of files) {
    const i = p.indexOf('/');
    if (i !== -1) dirs.add(p.slice(0, i));
  }
  return ['.', ...[...dirs].sort()];
}

/** The memo of `includeRoots` for one census set. `resolveEdges` runs once per file with the
 *  same `ctx`, which holds the same `Set` identity. To recompute the top-level scan per file
 *  would cost O(files²) on a big C++ repository. The `WeakMap` ties the lifetime of the set
 *  to the extract, so there is no staleness across runs, and the factory builds a fresh set
 *  for each extract. */
const includeRootsCached = memoizeWeak(includeRoots);

/** The census paths of the cpp family, shortest first and then in alphabetical order. This is
 *  the candidate order for the suffix match. The paths come from the module-to-file map of
 *  the importer, whose keys are the paths themselves (identity keys). The memo works per map,
 *  the same way as `includeRootsCached`. */
const sortedCppFiles = memoizeWeak((moduleToFile: Map<string, string>) => [...moduleToFile.keys()].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)));

/** Try the suffix match, the fallback for an include that no probe reached but that some
 *  census file ends with. Such a header is found through a deep `-I` root, for example
 *  `ggml/include` in llama or `_libs/include` in pandas, and the probe roots cover only the
 *  top-level directories.
 *
 *  The function accepts a unique twin only. Two files that end with the same include, for
 *  example the common name `config.h` under two roots, are indistinguishable without a read
 *  of `-I`. A guessed pick would be a wrong edge, so the function returns an honest
 *  unresolved result instead.
 *
 *  The function strips the leading `../` segments. From `ggml/src/ggml-cann/`, the include
 *  `../include/ggml-cann.h` is `-I ggml/include` plus the relative prefix. The meaningful
 *  part for a suffix scan is `include/ggml-cann.h`, because the `..` segments cancel inside
 *  the root and mean nothing to a bare path scan. The function normalizes the include first,
 *  which resolves the `.` and `..` segments, and then strips them. A census path never
 *  contains a `.` or `..` segment, so the raw form can never match. */
function suffixMatch(include: string, files: readonly string[]): string | undefined {
  const target = `/${posix.normalize(include).replace(/^(\.\.\/)+/, '')}`;
  const hits = files.filter((p) => p.endsWith(target));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Return the candidate targets for an include, in probe order:
 *  1. Relative to the directory of the importer, quoted includes only. The C standard
 *     searches the directory of the including file first for a `"..."` include, and the
 *     `.` and `..` segments normalize away.
 *  2. Relative to the repository, against every top-level code directory, for both forms.
 *     This is the flattened approximation of `-I`: a header is addressed bare, or under an
 *     `include/`, `src/`, or `lib/` root.
 *
 *  A candidate that escapes above the repository root drops out, because it cannot be in the
 *  census. The function is pure over the file set and does not chase the file system. */
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
      // Join and normalize per root, and drop a candidate only when the RESULT escapes the
      // repository. A `..` include is not dropped before the join: `-I src` plus
      // `../src/x.h` gives `src/../src/x.h`, which is `src/x.h`, a valid in-repository
      // target that the importer-directory probe cannot reach from a different directory.
      // Only an escape (`../../out.h` from `src/`) drops.
      const probe = root === '.' ? clean : posix.normalize(`${root}/${clean}`);
      if (!probe.startsWith('..') && probe !== '.') out.push(probe);
    }
  }
  return [...new Set(out)];
}

/** C++ has no concept of a package or a module, so every file is its own unit. The module
 *  key is therefore the path of the file itself (the identity). The census map then holds
 *  path to path pairs, and resolution probes the map by candidate path. */
const fileToModule = (path: string): string => path;

/** The C and C++ importer: tree-sitter analysis and include-to-file resolution through the
 *  census. A quoted include is local by definition, and a missing one becomes unresolved,
 *  which is a problem for the LLM to solve. An angle include is external unless a census hit
 *  proves that the code owns it. The importer reads no build system and no `-I` option,
 *  because it works from the source only (the design philosophy).
 *
 *  The importer has a deliberate ceiling: the `-I` roots are the top-level code directories
 *  only, derived from the census. The suffix fallback covers the deeper roots (`ggml/include`,
 *  `_libs/include` in pandas, and a vendored gtest at `test/gtest/...`). A header still stays
 *  unresolved in two cases: its suffix appears nowhere in the census, or several twins share
 *  its suffix (an ambiguous common name such as `config.h` under two deep roots). A guessed
 *  twin would be a wrong edge, and the unique-twin gate keeps the result honest. */
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
    const roots = includeRootsCached(ctx.files); // Stable across the includes of this file, and memoized per census.
    const cppFiles = sortedCppFiles(ctx.moduleToFile); // The candidates for the suffix match, shortest first.
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
