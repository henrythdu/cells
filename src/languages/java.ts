import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, MODULE_SEP } from './tree-sitter.js';

// --- AST → package + import paths ---

/** The declared package of a file (`package com.acme.util;` → `com.acme.util`). The
 *  package_declaration's scoped_identifier carries the FULL dotted path as its text (the
 *  nested nodes are irrelevant — text slicing is enough). */
function packageOf(root: Node): string | undefined {
  for (const c of root.namedChildren) {
    if (c.type === 'package_declaration') {
      const si = c.namedChildren.find((x) => x.type === 'scoped_identifier');
      return si?.text;
    }
  }
  return undefined;
}

/** An `import` statement: the dotted path + whether it's a wildcard (`import a.b.*;`). Static
 *  imports carry the member too (`com.acme.util.Helper.escape`) — resolution strips it when the
 *  full path misses. The `*` is a separate token (not in the scoped_identifier), detected via
 *  the directive text. */
export interface JavaImport {
  fqn: string;
  star: boolean;
}

/** What one file's analysis yields: its declared package (the importer's own package — the
 *  ownership anchor for unresolved classification) + its imports. */
export interface JavaAnalysis {
  pkg: string | undefined;
  imports: JavaImport[];
}

/** Import paths declared in a Java file. import_declaration → scoped_identifier (its text IS
 *  the whole dotted path). Java has no relative imports — every import is fully qualified.
 *  Wildcards: the `*` is a named `asterisk` child of the directive (AST-structural, not a
 *  text heuristic). */
function extractImports(root: Node): JavaImport[] {
  const out: JavaImport[] = [];
  collectImports(root, out);
  return out;
}

function collectImports(node: Node, out: JavaImport[]): void {
  if (node.type === 'import_declaration') {
    const si = node.namedChildren.find((c) => c.type === 'scoped_identifier');
    const text = si?.text;
    if (text) out.push({ fqn: text, star: node.namedChildren.some((c) => c.type === 'asterisk') });
    return; // a directive's children are the package + optional star — no deeper imports
  }
  for (const child of node.namedChildren) collectImports(child, out);
}

// --- unresolved classification ---

/** Does this unresolved import name a class that should live in the IMPORTER's OWN package?
 *  The class's package, then the OUTER class's package (`a.b.Outer.Inner` → a/b/Outer.java →
 *  package `a.b`) — if either equals the importer's package, the import is unambiguously broken
 *  own-code (a missing sibling class; retrofit's generated PhoneProtos imported from the SAME
 *  package). Anything else is external-or-ambiguous and silent: a Maven dep under an OWNED
 *  namespace (guava owns `com.google.common` — Truth and Jimfs are sibling-project libs one
 *  level below it) is structurally indistinguishable from a missing own class except by the
 *  importer's package. Under-flags cross-package typos — the honest direction (never a false
 *  flag). */
function looksLocal(imp: JavaImport, pkg: string | undefined): boolean {
  if (!pkg) return false;
  let f = imp.fqn;
  for (let depth = 0; depth < 2; depth++) {
    const i = f.lastIndexOf('.');
    if (i <= 0) return false;
    f = f.slice(0, i);
    if (f === pkg) return true;
  }
  return false;
}

// --- module identity: FQN from the package DECL (content), not the path ---

/** The `::` prefix under which Java module keys live. The factory's mods enrichment joins with
 *  MODULE_SEP (rust-shaped); java sets its key as `<sep><fqn>` — an EMPTY importerModule
 *  (fileToModule) keeps the prefix to exactly the separator. Fully private to this file:
 *  resolution always looks up `<sep><fqn>`, and nothing downstream consumes the keys. */
const KEY_PREFIX = MODULE_SEP;

// --- resolution: import FQN → file (via the census) ---


/** package → its deterministic representative file (shortest FQN, then alpha — Go's
 *  package-representative model), memoized per module→file map. Called once per WILDCARD
 *  import — a full map scan per wildcard would be O(wildcards × modules) on big repos (ocr
 *  HIGH; elasticsearch ~31k modules). WeakMap: the map dies with the extract, no cross-run
 *  staleness (same shape as cpp.ts's includeRootsCached). */
const repCache = new WeakMap<Map<string, string>, Map<string, string>>();
function representativeOf(pkg: string, moduleToFile: Map<string, string>): string | null {
  let cache = repCache.get(moduleToFile);
  if (!cache) {
    cache = new Map();
    for (const k of moduleToFile.keys()) {
      if (!k.startsWith(KEY_PREFIX)) continue;
      const fqn = k.slice(KEY_PREFIX.length);
      const i = fqn.lastIndexOf('.');
      if (i <= 0) continue;
      const p = fqn.slice(0, i);
      const prev = cache.get(p);
      if (prev === undefined || fqn.length < prev.length || (fqn.length === prev.length && fqn < prev)) cache.set(p, fqn);
    }
    repCache.set(moduleToFile, cache);
  }
  const best = cache.get(pkg) ?? null;
  return best ? (moduleToFile.get(KEY_PREFIX + best) ?? null) : null;
}

/** Java importer — tree-sitter analysis + FQN→file resolution via the census. Java has no
 *  relative imports and no package-module file (no __init__ analog): every import is a
 *  fully-qualified class (or package, for wildcards), so resolution is an exact key lookup.
 *  No build-system reads — the package DECL is the identity (Maven/Gradle/Ant layouts all
 *  work; a path-derived FQN would need src-root probes and lie on layout mismatch).
 *  ponytail: wildcards resolve to ONE representative file per package (Go parity); a package
 *  whose members span cells is drawn as a single edge — upgrade to per-file edges if a real
 *  repo's graph needs the granularity. Kotlin files are invisible (no kotlin grammar). */
export const javaImporter = createTreeSitterImporter<JavaAnalysis>({
  name: 'java',
  extensions: ['.java'],
  wasmBasename: 'tree-sitter-java.wasm',
  // The package decl (content) defines identity, not the path — the mods hook below registers
  // the real `::<fqn>` key. The path-only fileToModule hook has nothing path-derived to offer,
  // so every file maps to '' (one inert map entry; resolution never consults it).
  fileToModule: () => '',
  analyze: (root, sourcePath) => {
    const pkg = packageOf(root);
    const cls = posix.basename(sourcePath).replace(/\.java$/, '');
    return {
      // key = `::<pkg>.<cls>` — the FQN imports address the file by. A file's public class
      // matches its basename (javac enforces it), so the basename IS the importable identity.
      // No package decl (default package) → no key → not importable from anywhere (correct —
      // default-package classes can't be imported). Files with the same FQN (a test double in
      // src/test mirroring src/main) resolve to the LEXICALLY-LAST file — deterministic, and
      // the same last-set-wins shape as Go's package representatives.
      mods: pkg ? [{ path: [`${pkg}.${cls}`], targetFile: null }] : [],
      reexports: [],
      uses: { pkg, imports: extractImports(root) },
    };
  },
  resolveEdges: (uses, sourcePath, _importerModule, ctx) => {
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const imp of uses.imports) {
      if (imp.star) {
        // package-level dependency — one representative edge (Go parity); never flagged (a
        // wildcard to a missing package is external or a no-op, not a broken import).
        const rep = representativeOf(imp.fqn, ctx.moduleToFile);
        if (rep && rep !== sourcePath) edges.push({ fromFile: sourcePath, toFile: rep, import: `${imp.fqn}.*` });
        continue;
      }
      // exact class, then progressively shorter prefixes: inner classes + static members
      // address the class FILE, possibly through nesting (`SampleElements.Strings.AFTER_LAST`
      // → `SampleElements`; a same-file nested enum resolves to its own file and is dropped
      // as a self-edge). First hit wins — most specific. The package-only candidate can never
      // hit (no package-level keys).
      let target: string | null = null;
      let f = imp.fqn;
      for (;;) {
        target = ctx.moduleToFile.get(KEY_PREFIX + f) ?? null;
        if (target) break;
        const i = f.lastIndexOf('.');
        if (i <= 0) break;
        f = f.slice(0, i);
      }
      if (target) {
        if (target !== sourcePath) edges.push({ fromFile: sourcePath, toFile: target, import: imp.fqn });
      } else if (looksLocal(imp, uses.pkg)) {
        unresolved.push({ fromFile: sourcePath, import: imp.fqn });
      }
    }
    return { edges, unresolved };
  },
});
