import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ImportEdge, UnresolvedImport } from '../imports.js';
import { createTreeSitterImporter } from './tree-sitter.js';

// --- module-path derivation: file → Go package key ---

/** Nearest ancestor dir holding a go.mod → the module root; null if none. Same walk-up probe
 *  as rust's findCrateRoot (repo-relative paths; baseDir may point at an extracted HEAD tree). */
function findGoMod(filePath: string, baseDir: string): string | null {
  let dir = dirname(filePath);
  for (;;) {
    if (existsSync(join(baseDir, dir, 'go.mod'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The `module` directive of the nearest go.mod — the import-path prefix every package in the
 *  module is addressed by. Cached per absolute go.mod path: fileToModule runs once per file and
 *  re-reading the same go.mod hundreds of times would dominate a big scan. Keyed by the ABSOLUTE
 *  path (resolve(baseDir, …)), so distinct baseDirs/repos never collide; the cells CLI is
 *  one-shot per run — a watch-mode caller reusing a path with new content would need to clear it. */
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
  moduleCache.set(abs, path); // store null as null — `?? 'gopath'` must see the same value every call
  return path;
}

/** `pkg/foo/bar.go` under module `example.com/proj` → `example.com/proj::pkg::foo` — the
 *  PACKAGE key (a Go package is a directory: every .go file in a dir maps to the SAME key, and
 *  the factory's last-set-wins picks a deterministic representative file for the edge target).
 *  The module path stays one key segment (slashes intact) — import paths address packages by
 *  it, so resolution replaces the module prefix verbatim. The root package → the module path
 *  alone. No go.mod (GOPATH-era): the key is the relative dir `::`-joined, which is what
 *  import-path probes resolve to; a root-dir file gets an inert sentinel key (nothing can
 *  import it). */
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

// --- AST → import paths ---

/** Import paths declared in a Go file. import_declaration → import_spec (single) or
 *  import_spec_list → import_spec; each spec = optional package_identifier (an alias, `_` for
 *  side-effect, `.` for dot-imports — irrelevant to the dependency) + interpreted_string_literal
 *  (the path). */
function extractImports(root: Node): string[] {
  const out: string[] = [];
  collectImports(root, out);
  return out;
}

function collectImports(node: Node, out: string[]): void {
  if (node.type === 'import_spec') {
    const lit = node.namedChildren.find((c) => c.type === 'interpreted_string_literal');
    const text = lit?.text;
    if (text && text.length >= 2) out.push(text.slice(1, -1));
    return; // a spec's children are just the alias + the literal — no deeper imports
  }
  for (const child of node.namedChildren) collectImports(child, out);
}

// --- resolution: import path + importer package → file (via the module→file map) ---

/** Candidate package keys for an import path: the module-relative form (module path + `::` +
 *  dir segments — the shape of every key in a module'd repo), then the plain `::`-joined form
 *  (GOPATH/no-module layout). Deduped. */
function candidateKeys(imp: string, modulePath: string): string[] {
  const out: string[] = [];
  if (modulePath && (imp === modulePath || imp.startsWith(modulePath + '/'))) {
    if (imp === modulePath) out.push(modulePath);
    else {
      const rest = imp.slice(modulePath.length + 1).split('/').join('::');
      out.push(rest ? `${modulePath}::${rest}` : modulePath);
    }
  }
  out.push(imp.split('/').join('::'));
  return [...new Set(out)];
}

/** Resolve a relative import (`./foo`, `../foo`, `./../foo`) against the importer's package key —
 *  GOPATH-era syntax, a compile error in modules but resolved honestly when the target exists.
 *  Pops one segment per `..` (never the first — the module/first segment); escaping the root →
 *  no candidates (broken either way). Mixed `./`/`../` prefixes are stripped iteratively (Go
 *  normalizes them the same way). */
function relativeKeys(imp: string, importerModule: string): string[] {
  if (!imp.startsWith('.')) return [];
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
  const min = 1; // keep the module/first segment
  while (up > 0 && segs.length > min) {
    segs.pop();
    up--;
  }
  if (up > 0) return []; // escapes the root — broken import, nothing to resolve to
  const tail = rest.split('/').join('::');
  return [tail ? `${segs.join('::')}::${tail}` : segs.join('::')];
}

/** Does this import look local (owned code)? Relative paths always do; absolute ones if they
 *  address this module. Everything else — stdlib (`fmt`), third-party (`github.com/other/…`),
 *  cgo's `"C"` — is external and silently skipped. No go.mod (GOPATH): the first segment of
 *  every import is a domain, so only a resolve hit makes it local — a miss is external, not a
 *  broken local (without a module there's no member list to distinguish them). */
function looksLocal(imp: string, modulePath: string): boolean {
  if (imp.startsWith('.')) return true;
  return modulePath !== '' && (imp === modulePath || imp.startsWith(modulePath + '/'));
}

/** Resolve ONE import path to a package file + whether it's local. Pure over the module→file
 *  map (no FS chasing — the map IS the ownership-derived census). The factory's last-set-wins
 *  makes any file in the target dir's package the deterministic representative. */
export function resolvePackageImport(imp: string, importerModule: string, moduleToFile: Map<string, string>): { toFile: string | null; local: boolean } {
  // The importer's module path is its key's first segment (module paths can't contain `::`);
  // files outside any module have a dir-derived first segment instead.
  const modulePath = importerModule.split('::')[0];
  const keys = [...candidateKeys(imp, modulePath), ...relativeKeys(imp, importerModule)];
  let toFile: string | null = null;
  for (const k of keys) {
    const hit = moduleToFile.get(k);
    if (hit) {
      toFile = hit;
      break;
    }
  }
  return { toFile, local: looksLocal(imp, modulePath) };
}

/** Go importer — tree-sitter analysis + package→file resolution via ownership. A Go package is
 *  a directory, so keys are package-level and the map's representative file stands for the whole
 *  dir. No mods, no re-exports, no item chains — exact package-path lookup. */
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
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const imp of imports) {
      const { toFile, local } = resolvePackageImport(imp, importerModule, ctx.moduleToFile);
      if (toFile && toFile !== sourcePath) {
        edges.push({ fromFile: sourcePath, toFile, import: imp });
      } else if (!toFile && local) {
        unresolved.push({ fromFile: sourcePath, import: imp });
      }
    }
    return { edges, unresolved };
  },
});
