import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- Module-path derivation: from a file to a Go package key ---

/** Return the module root: the nearest ancestor directory that holds a `go.mod` file. The
 *  function returns null when no ancestor holds one. The probe walks up the tree, the same
 *  way as `findCrateRoot` in rust. All paths are repository-relative, and `baseDir` can point
 *  at an extracted HEAD tree. */
function findGoMod(filePath: string, baseDir: string): string | null {
  let dir = dirname(filePath);
  for (;;) {
    if (existsSync(join(baseDir, dir, 'go.mod'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Return the `module` directive of the nearest `go.mod`. This directive is the import-path
 *  prefix that addresses every package in the module. The result is cached per absolute
 *  `go.mod` path: `fileToModule` runs once per file, and to re-read the same `go.mod`
 *  hundreds of times would dominate a big scan. The cache key is the absolute path
 *  (`resolve(baseDir, ...)`), so distinct `baseDir` values and repositories never collide.
 *  The cells CLI runs one time per invocation. A watch-mode caller that reuses a path with
 *  new content must clear the cache. */
const moduleCache = new Map<string, string | null>();
function modulePathOf(goModDir: string, baseDir: string): string | null {
  const abs = resolve(baseDir, goModDir, 'go.mod');
  const hit = moduleCache.get(abs);
  if (hit !== undefined) return hit;
  let path: string | null = null;
  try {
    const m = readFileSync(abs, 'utf8').match(/^module\s+(\S+)/m);
    path = m ? m[1] : null;
  } catch {
    path = null;
  }
  moduleCache.set(abs, path); // Store null as null, so `?? 'gopath'` sees the same value on every call.
  return path;
}

/** Map `pkg/foo/bar.go` under the module `example.com/proj` to `example.com/proj::pkg::foo`,
 *  which is the package key. A Go package is a directory: every `.go` file in a directory
 *  maps to the same key. The last-set-wins rule of the factory picks a deterministic
 *  representative file as the edge target.
 *
 *  The module path stays one key segment, with its slashes intact, because import paths
 *  address packages by it. Resolution therefore replaces the module prefix verbatim. The root
 *  package maps to the module path alone.
 *
 *  Without a `go.mod` (the GOPATH era) the key is the relative directory with `::`
 *  separators, which is what import-path probes resolve to. A file in the root directory gets
 *  an inert sentinel key, because nothing can import it. */
export function fileToModule(path: string, _moduleRoot?: string, baseDir = '.'): string {
  const goMod = findGoMod(path, baseDir);
  if (!goMod) {
    const rel = dirname(path);
    return rel === '.' ? '__root__' : rel.split('/').join('::');
  }
  const modulePath = modulePathOf(goMod, baseDir) ?? 'gopath';
  const rel = goMod === '.' ? dirname(path) : dirname(path).slice(goMod.length + 1);
  const pkg = rel === '.' ? '' : rel.split('/').join('::');
  return pkg ? `${modulePath}::${pkg}` : modulePath;
}

// --- From the AST to the import paths ---

/** Return the import paths that a Go file declares. The tree is import_declaration, then
 *  import_spec (one import) or import_spec_list, then import_spec. Each
 *  spec holds an optional package_identifier and an interpreted_string_literal. The
 *  package_identifier is an alias: `_` for a side effect and `.` for a dot import. The alias
 *  does not matter to the dependency, and the literal holds the path. */
function extractImports(root: Node): string[] {
  const out: string[] = [];
  collectImports(root, out);
  return out;
}

function collectImports(node: Node, out: string[]): void {
  if (node.type === 'import_spec') {
    // Go permits both forms: a quoted path and a raw path in backticks. A raw path is legal
    // and common for generated code, so a check for the quoted form alone drops a real
    // dependency without an edge and without a diagnostic.
    const lit = node.namedChildren.find((c) => c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal');
    const text = lit?.text;
    if (text && text.length >= 2) out.push(text.slice(1, -1));
    return; // The children of a spec are only the alias and the literal, so there are no deeper imports.
  }
  for (const child of node.namedChildren) collectImports(child, out);
}

// --- Resolution: from an import path and the importer package to a file, through the module-to-file map ---

/** Return the module paths that are present in this partition. A module path is the first
 *  segment of every module key. In a repository with a module, this segment is the `module`
 *  directive of `go.mod`. A nested `go.mod` is a sub-module, such as `internal/legacy` and
 *  `internal/backend/remote-state/*` in terraform. The keys of those files carry the full
 *  module path as their first segment.
 *
 *  If the function strips any of these paths, a cross-sub-module import resolves from any
 *  importer. The longest path comes first, because the path of a sub-module is the more
 *  specific owner. The function derives the paths from the census map, so it needs no extra
 *  `go.mod` reads. The map is stable during the resolution of phase 2, so a caller computes
 *  the paths one time and passes them down. Python's `localPackages` sets the precedent. */
export function modulePathsOf(moduleToFile: Map<string, string>): string[] {
  const set = new Set<string>();
  for (const k of moduleToFile.keys()) {
    const first = k.split('::')[0];
    if (first) set.add(first);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/** The memo per extract for `modulePathsOf`. `resolveEdges` runs once per file with one
 *  shared `moduleToFile` map, and the factory builds the map one time per extract. To derive
 *  the paths per file would be O(files × modules) redundant work, because the map is frozen
 *  after the enrichment of phase 1. The key is the identity of the map, so a fresh map per
 *  extract gives a memo per extract and no leak across trees. Python's `derivedFacts` sets the
 *  precedent. */
const modulePathsCache = new WeakMap<Map<string, string>, string[]>();
function modulePathsCached(moduleToFile: Map<string, string>): string[] {
  let paths = modulePathsCache.get(moduleToFile);
  if (!paths) {
    paths = modulePathsOf(moduleToFile);
    modulePathsCache.set(moduleToFile, paths);
  }
  return paths;
}

/** Return the candidate package keys for an import path. The first form is module-relative:
 *  each known module path, then `::`, then the directory segments. This is the shape of the
 *  keys under that module. The second form is the plain `::`-joined path, for the GOPATH
 *  layout with no module. The result is deduplicated. */
function candidateKeys(imp: string, modulePaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const mp of modulePaths) {
    if (imp === mp) out.push(mp);
    else if (imp.startsWith(`${mp}/`)) {
      const rest = imp
        .slice(mp.length + 1)
        .split('/')
        .join('::');
      out.push(rest ? `${mp}::${rest}` : mp);
    }
  }
  out.push(imp.split('/').join('::'));
  return [...new Set(out)];
}

/** Resolve a relative import (`./foo`, `../foo`, `./../foo`) against the package key of the
 *  importer. This syntax is from the GOPATH era and is a compile error in modules, but the
 *  function resolves it honestly when the target exists. Each `..` pops one segment, but
 *  never the first segment, which is the module segment. An import that escapes the root has
 *  no candidates, because it is broken in both cases. The function strips mixed `./` and
 *  `../` prefixes in a loop, the same way as Go normalizes them. */
function relativeKeys(imp: string, importerModule: string): string[] {
  if (!imp.startsWith('.')) return [];
  if (importerModule === '__root__') return []; // A file in the GOPATH root has no directory to resolve against, so the import stays unresolved. A relative import from a root directory is broken in GOPATH anyway.
  let rest = imp;
  let up = 0;
  for (;;) {
    if (rest.startsWith('../')) {
      up++;
      rest = rest.slice(3);
    } else if (rest === '..') {
      up++;
      rest = '';
    } else if (rest.startsWith('./')) {
      rest = rest.slice(2);
    } else {
      break;
    }
  }
  const segs = importerModule.split('::');
  const min = 1; // Keep the module segment (the first segment).
  while (up > 0 && segs.length > min) {
    segs.pop();
    up--;
  }
  if (up > 0) return []; // The import escapes the root, so it is broken and there is nothing to resolve to.
  const tail = rest.split('/').join('::');
  return [tail ? `${segs.join('::')}::${tail}` : segs.join('::')];
}

/** Say whether this import looks local, which means that it addresses owned code. A relative
 *  path always looks local. An absolute path looks local when it addresses any known module
 *  path. Everything else is external and silently skipped: the standard library (`fmt`), a
 *  third-party package (`github.com/other/...`), and the `"C"` of cgo.
 *
 *  Without a `go.mod` (GOPATH) the first segments are top-level directories. Only a resolve
 *  hit makes an import local, and a miss is external, not a broken local. Without a module
 *  there is no member list to tell the two apart. */
function looksLocal(imp: string, modulePaths: readonly string[]): boolean {
  if (imp.startsWith('.')) return true;
  return modulePaths.some((mp) => imp === mp || imp.startsWith(`${mp}/`));
}

/** Resolve one import path to a package file, and say whether the import is local. The
 *  function is pure over the module-to-file map and does not chase the file system, because
 *  the map is the module map derived from the census. The last-set-wins rule of the factory
 *  makes any file in the package of the target directory a deterministic representative. */
export function resolvePackageImport(imp: string, importerModule: string, moduleToFile: Map<string, string>, modulePaths: readonly string[]): { toFile: string | null; local: boolean } {
  const keys = [...candidateKeys(imp, modulePaths), ...relativeKeys(imp, importerModule)];
  let toFile: string | null = null;
  for (const k of keys) {
    const hit = moduleToFile.get(k);
    if (hit) {
      toFile = hit;
      break;
    }
  }
  return { toFile, local: looksLocal(imp, modulePaths) };
}

/** The Go importer: tree-sitter analysis and package-to-file resolution through the census. A
 *  Go package is a directory, so the keys are at package level and the representative file of
 *  the map stands for the whole directory. There are no mods, no re-exports, and no item
 *  chains, only an exact lookup of the package path. */
export const goImporter = createTreeSitterImporter<string[]>({
  name: 'go',
  extensions: ['.go'],
  wasmBasename: 'tree-sitter-go.wasm',
  fileToModule,
  analyze: (root) => ({
    mods: [],
    reexports: [],
    uses: extractImports(root),
  }),
  resolveEdges: (imports, sourcePath, importerModule, ctx) => {
    const modulePaths = modulePathsCached(ctx.moduleToFile); // The memo per extract, stable across files.
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const imp of imports) {
      const { toFile, local } = resolvePackageImport(imp, importerModule, ctx.moduleToFile, modulePaths);
      if (toFile && toFile !== sourcePath) {
        edges.push({ fromFile: sourcePath, toFile, import: imp });
      } else if (!toFile && local) {
        unresolved.push({ fromFile: sourcePath, import: imp });
      }
    }
    return { edges, unresolved };
  },
});
