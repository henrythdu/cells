import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, SourceFile, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, memoizeWeak, nearestCandidate } from './tree-sitter.js';

// --- AST → import paths ---

/** An `import` statement: the dotted path + whether it's a wildcard (`import a.b.*;`). Static
 *  imports carry the member too (`com.acme.util.Helper.escape`) — resolution strips it when the
 *  full path misses. The `*` is a separate token (not in the scoped_identifier), detected via
 *  the directive text. */
interface JavaImport {
  fqn: string;
  star: boolean;
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

/** The content-aware module key: the file's FQN = package decl + basename. Keys are PLAIN
 *  FQNs (`com.acme.Util`) — no prefix, no mods (the identity is a key in the map, not a
 *  declared submodule). No package decl (default package) → undefined → the fileToModule
 *  fallback `''` (inert; default-package classes can't be imported from anywhere). The regex
 *  is source-based and the map builds before parse — the AST is unavailable here (analyze
 *  still sees it for imports; the identity is a lookup key, not an analysis). Comments are
 *  stripped first: `package` must be the first statement, but a commented-out decl (block or
 *  `//` line) would otherwise match first and forge the identity (ocr HIGH — the old
 *  AST-based packageOf was immune). */
function moduleKeyOf(file: SourceFile): string | undefined {
  const stripped = file.content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pkg = stripped.match(/^\s*package\s+([\w.$]+)\s*;/m)?.[1];
  if (!pkg) return undefined;
  return `${pkg}.${posix.basename(file.path).replace(/\.java$/, '')}`;
}

// --- resolution: import FQN → file (via the census) ---

/** package → its deterministic representative FQN (shortest, then alpha — Go's
 *  package-representative model), computed ONCE per module→file map. Called once per WILDCARD
 *  import — a full map scan per wildcard would be O(wildcards × modules) on big repos (ocr
 *  HIGH; elasticsearch ~31k modules). memoizeWeak: the map dies with the extract, no
 *  cross-run staleness. */
const representativeOf = memoizeWeak((moduleToFile: Map<string, string>) => {
  const byPkg = new Map<string, string>();
  for (const k of moduleToFile.keys()) {
    const i = k.lastIndexOf('.');
    if (i <= 0) continue; // `''` (default-package fallback) and non-FQN keys — not class keys
    const pkg = k.slice(0, i);
    const prev = byPkg.get(pkg);
    if (prev === undefined || k.length < prev.length || (k.length === prev.length && k < prev)) byPkg.set(pkg, k);
  }
  return byPkg;
});

/** Java importer — tree-sitter analysis + FQN→file resolution via the census. Java has no
 *  relative imports and no package-module file (no __init__ analog): every import is a
 *  fully-qualified class (or package, for wildcards), so resolution is an exact key lookup.
 *  No build-system reads — the package DECL is the identity (Maven/Gradle/Ant layouts all
 *  work; a path-derived FQN would need src-root probes and lie on layout mismatch).
 *  ponytail: wildcards resolve to ONE representative file per package (Go parity); a package
 *  whose members span cells is drawn as a single edge — upgrade to per-file edges if a real
 *  repo's graph needs the granularity. Kotlin files are invisible (no kotlin grammar). */
export const javaImporter = createTreeSitterImporter<JavaImport[]>({
  name: 'java',
  extensions: ['.java'],
  wasmBasename: 'tree-sitter-java.wasm',
  // The package decl (content) defines identity — moduleKeyOf returns the plain FQN key;
  // fileToModule stays as the inert fallback for default-package files (no key — unimportable).
  fileToModule: () => '',
  moduleKeyOf,
  analyze: (root) => ({
    mods: [],
    reexports: [],
    uses: extractImports(root),
  }),
  resolveEdges: (imports, sourcePath, importerModule, ctx) => {
    // The importer's own package = its FQN key minus the class segment ('' → undefined — a
    // default-package file's imports are never classified local).
    const pkg = importerModule.includes('.') ? importerModule.slice(0, importerModule.lastIndexOf('.')) : undefined;
    const reps = representativeOf(ctx.moduleToFile); // pkg → representative FQN, once per extract
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const imp of imports) {
      if (imp.star) {
        // package-level dependency — one representative edge (Go parity); never flagged (a
        // wildcard to a missing package is external or a no-op, not a broken import).
        const best = reps.get(imp.fqn);
        const rep = best ? nearestCandidate(ctx.moduleCandidates.get(best) ?? [], sourcePath) : null;
        if (rep && rep !== sourcePath) edges.push({ fromFile: sourcePath, toFile: rep, import: `${imp.fqn}.*` });
        continue;
      }
      // exact class, then progressively shorter prefixes: inner classes + static members
      // address the class FILE, possibly through nesting (`SampleElements.Strings.AFTER_LAST`
      // → `SampleElements`; a same-file nested enum resolves to its own file and is dropped
      // as a self-edge). First hit wins — most specific. The package-only candidate can never
      // hit (no package-level keys). F4: duplicate FQNs (mirror trees) resolve same-tree via
      // nearestCandidate — the old flat map gave every import whichever tree won the walk.
      let target: string | null = null;
      let f = imp.fqn;
      for (;;) {
        target = nearestCandidate(ctx.moduleCandidates.get(f) ?? [], sourcePath);
        if (target) break;
        const i = f.lastIndexOf('.');
        if (i <= 0) break;
        f = f.slice(0, i);
      }
      if (target) {
        if (target !== sourcePath) edges.push({ fromFile: sourcePath, toFile: target, import: imp.fqn });
      } else if (looksLocal(imp, pkg)) {
        unresolved.push({ fromFile: sourcePath, import: imp.fqn });
      }
    }
    return { edges, unresolved };
  },
});
