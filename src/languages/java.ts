import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, SourceFile, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter, memoizeWeak, nearestCandidate } from './tree-sitter.js';

// --- From the AST to the import paths ---

/** An `import` statement: the dotted path and whether it is a wildcard (`import a.b.*;`). A
 *  static import carries the member too (`com.acme.util.Helper.escape`), and resolution
 *  strips the member when the full path misses. The `*` is a separate token and is not part
 *  of the scoped_identifier, so the code detects it through the text of the directive. */
interface JavaImport {
  fqn: string;
  star: boolean;
}

/** Return the import paths that a Java file declares. The tree is import_declaration, then
 *  scoped_identifier, and the text of the scoped identifier is the whole dotted path. Java
 *  has no relative imports, so every import is fully qualified. For a wildcard, the `*` is an
 *  `asterisk` child of the directive, so the code detects it from the AST structure and not
 *  from the text. */
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
    return; // The children of a directive are the package and an optional star, so there are no deeper imports.
  }
  for (const child of node.namedChildren) collectImports(child, out);
}

// --- Classification of unresolved imports ---

/** Say whether this unresolved import names a class that should live in the package of the
 *  importer itself.
 *
 *  The function takes the package of the class, then the package of the outer class
 *  (`a.b.Outer.Inner` becomes `a/b/Outer.java`, whose package is `a.b`). If either package
 *  equals the package of the importer, the import is unambiguously broken own code: a
 *  sibling class is missing. Retrofit's generated PhoneProtos had an import from the same
 *  package, which is this case.
 *
 *  Anything else is external or ambiguous, and the function stays silent. A Maven dependency
 *  under an owned namespace is structurally indistinguishable from a missing own class,
 *  except by the package of the importer. Guava owns `com.google.common`, and Truth and
 *  Jimfs are sibling-project libraries one level below it. The function under-flags a
 *  cross-package typo, which is the honest direction, because it never raises a false flag. */
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

// --- Module identity: the FQN from the package declaration in the content, not from the path ---

/** Return the module key of a file, which is content-aware: the FQN of the file is the
 *  package declaration plus the basename. The keys are plain FQNs (`com.acme.Util`), with no
 *  prefix and no mods, because the identity is a key in the map and not a declared
 *  submodule. Without a package declaration (the default package) the function returns
 *  undefined, and the `fileToModule` fallback `''` is inert, because no code can import a
 *  class of the default package.
 *
 *  The regex works on the source, and the map builds before the parse, so the AST is not
 *  available here. The `analyze` hook still sees the AST for imports, but the identity is a
 *  lookup key and not an analysis. The function strips the comments first: the `package`
 *  keyword must be the first statement, but a commented-out declaration (block or `//` line)
 *  would otherwise match first and forge the identity. An AST-based lookup of the package is
 *  immune by construction. */
function moduleKeyOf(file: SourceFile): string | undefined {
  const stripped = file.content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pkg = stripped.match(/^\s*package\s+([\w.$]+)\s*;/m)?.[1];
  if (!pkg) return undefined;
  return `${pkg}.${posix.basename(file.path).replace(/\.java$/, '')}`;
}

// --- Resolution: from an import FQN to a file, through the census ---

/** Map a package to its deterministic representative FQN, which is the shortest FQN and then
 *  the first in alphabetical order. This is the package-representative model of Go.
 *
 *  The function computes the map one time per module-to-file map, because a full scan per
 *  wildcard import would cost O(wildcards × modules) on a big repository (elasticsearch has
 *  about 31k modules). The `memoizeWeak` helper ties the lifetime of the map to the extract,
 *  so there is no staleness across runs. */
const representativeOf = memoizeWeak((moduleToFile: Map<string, string>) => {
  const byPkg = new Map<string, string>();
  for (const k of moduleToFile.keys()) {
    const i = k.lastIndexOf('.');
    if (i <= 0) continue; // `''` (the default-package fallback) and non-FQN keys are not class keys.
    const pkg = k.slice(0, i);
    const prev = byPkg.get(pkg);
    if (prev === undefined || k.length < prev.length || (k.length === prev.length && k < prev)) byPkg.set(pkg, k);
  }
  return byPkg;
});

/** The Java importer: tree-sitter analysis and FQN-to-file resolution through the census.
 *  Java has no relative imports and no package-module file such as `__init__`, so every
 *  import is a fully-qualified class, or a package for a wildcard. Resolution is therefore an
 *  exact key lookup.
 *
 *  The importer reads no build-system files, because the package declaration is the identity.
 *  This approach works for Maven, Gradle, and Ant layouts. A path-derived FQN would need
 *  probes for the source root and would lie on a layout mismatch.
 *
 *  The importer has a deliberate ceiling: a wildcard resolves to one representative file per
 *  package, the same as Go. A package whose members span cells appears as a single edge.
 *  Upgrade to edges per file if the graph of a real repository needs that granularity. Kotlin
 *  files are invisible, because there is no Kotlin grammar. */
export const javaImporter = createTreeSitterImporter<JavaImport[]>({
  name: 'java',
  extensions: ['.java'],
  wasmBasename: 'tree-sitter-java.wasm',
  // The package declaration in the content defines the identity, and `moduleKeyOf` returns
  // the plain FQN key. `fileToModule` stays as the inert fallback for a file in the default
  // package, which has no key and cannot be imported.
  fileToModule: () => '',
  moduleKeyOf,
  analyze: (root) => ({
    mods: [],
    reexports: [],
    uses: extractImports(root),
  }),
  resolveEdges: (imports, sourcePath, importerModule, ctx) => {
    // The own package of the importer is its FQN key without the class segment. The class
    // segment comes from the FILE NAME, not from the last dot of the key: a nested class
    // lives in `Outer.Inner.java`, and a blind strip would read its package as
    // `com.acme.Outer`. An empty string becomes undefined, so the imports of a
    // default-package file are never classified local.
    const cls = posix.basename(sourcePath, '.java');
    // The key is always `package.ClassName`, so removing the file-name segment gives the
    // package. A file with no package declaration has an empty key, and its imports are never
    // local.
    const pkg: string | undefined = importerModule.endsWith(`.${cls}`) ? importerModule.slice(0, importerModule.length - cls.length - 1) : undefined;
    const reps = representativeOf(ctx.moduleToFile); // A map from package to representative FQN, computed one time per extract.
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const imp of imports) {
      if (imp.star) {
        // A package-level dependency gives one representative edge, the same as Go. The code
        // never flags it, because a wildcard to a missing package is external or a no-op and
        // not a broken import.
        const best = reps.get(imp.fqn);
        const rep = best ? nearestCandidate(ctx.moduleCandidates.get(best) ?? [], sourcePath) : null;
        if (rep && rep !== sourcePath) edges.push({ fromFile: sourcePath, toFile: rep, import: `${imp.fqn}.*` });
        else if (!best) {
          // `import static X.*` is a STATIC wildcard of a class, not of a package. The keys of
          // `reps` are packages, so the lookup always missed and the real dependency vanished.
          // The code strips the path progressively, the same way as for the member form: first
          // X, then its nesting prefix, down to the class file.
          let f = imp.fqn;
          for (;;) {
            const t = nearestCandidate(ctx.moduleCandidates.get(f) ?? [], sourcePath);
            if (t) {
              if (t !== sourcePath) edges.push({ fromFile: sourcePath, toFile: t, import: `${imp.fqn}.*` });
              break;
            }
            const i = f.lastIndexOf('.');
            if (i <= 0) break;
            f = f.slice(0, i);
          }
        }
        continue;
      }
      // Try the exact class, then progressively shorter prefixes. An inner class and a static
      // member address the class file, possibly through nesting (`SampleElements.Strings.AFTER_LAST`
      // becomes `SampleElements`). A nested enum in the same file resolves to its own file and
      // is dropped as a self-edge. The first hit wins, because it is the most specific. A
      // package-only candidate can never hit, because there are no package-level keys. A
      // duplicate FQN (a mirror tree) resolves in the same tree through `nearestCandidate`,
      // because a flat winner map would give every import whichever tree won the walk.
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
