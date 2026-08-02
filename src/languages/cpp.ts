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
  if (!clean.startsWith('..') && clean !== '.') {
    for (const root of roots) {
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
 *  ponytail: -I roots = top-level code dirs only — a DEEPER root (vendored gtest at
 *  test/gtest/gtest/gtest.h reached via `-I test/gtest`) stays unresolved; add depth-2
 *  probes if a real repo needs them. */
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
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const inc of includes) {
      const target = includeCandidates(inc, sourcePath, roots).find((c) => ctx.files.has(c));
      if (target) {
        if (target !== sourcePath) edges.push({ fromFile: sourcePath, toFile: target, import: inc.path });
      } else if (inc.quoted) {
        unresolved.push({ fromFile: sourcePath, import: inc.path });
      }
    }
    return { edges, unresolved };
  },
});
