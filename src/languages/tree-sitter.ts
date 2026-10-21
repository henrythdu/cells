import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser, type Tree } from 'web-tree-sitter';
import type { ImportEdge, Importer, ImportResult, SourceFile, UnresolvedImport } from '../imports.js';

/**
 * Shared infrastructure for the tree-sitter importers: a cache that holds one grammar WASM
 * singleton, and a factory that owns the parse loop. Each language importer supplies only
 * its language-specific logic: the module derivation, the AST analysis, and the resolution.
 */

// --- The grammar singleton cache: one `Parser` per grammar WASM, created lazily and memoized ---
const parsers = new Map<string, Promise<Parser>>();

// Serialize the grammar loads. `Language.load` of web-tree-sitter shares WASM state, and two
// loads that run at the same time race it: one grammar loads corrupted and the extraction
// returns empty results without an error. This chain makes the loads strictly sequential,
// even when callers run in parallel. The chain survives an individual failure, so a broken
// grammar does not wedge the others.
let loadChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = loadChain.then(fn);
  loadChain = run.catch(() => {});
  return run;
}

/** Load the tree-sitter `Parser` for a bundled grammar WASM one time, and cache it. */
export function getGrammarParser(wasmBasename: string): Promise<Parser> {
  let p = parsers.get(wasmBasename);
  if (!p) {
    p = serialized(async () => {
      await Parser.init();
      // The WASM files ship as static assets in `grammars/`, built with an ABI that matches
      // web-tree-sitter. The prebuilt pack `tree-sitter-wasms` uses an old CLI and is not
      // compatible.
      const wasm = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars', wasmBasename);
      let lang: Language;
      try {
        lang = await Language.load(readFileSync(wasm));
      } catch {
        throw new Error(`Failed to load grammar WASM at ${wasm} — ensure the 'grammars/' directory is bundled with cells.`);
      }
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    });
    parsers.set(wasmBasename, p);
    p.catch(() => parsers.delete(wasmBasename)); // Do not cache the rejection, so the next call can retry.
  }
  return p;
}

/** Verify the bundled grammar set in `grammars/manifest.json`. Every declared WASM file must
 *  exist in the package and must load against the bundled runtime, which is the authoritative
 *  ABI check. A missing file or an ABI mismatch means that the package is broken, even when no
 *  repository currently has files of that language. Without this check the lazy failure per
 *  language would stay silent. `cells health` calls this function. The loads run through the
 *  same serialized chain as the real parsing, so the check cannot race a concurrent grammar
 *  load. */
export async function checkGrammars(): Promise<{ lang: string; ok: boolean; error?: string }[]> {
  const grammarsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars');
  let manifest: { grammars: { lang: string; wasm: string }[] };
  try {
    manifest = JSON.parse(readFileSync(join(grammarsDir, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    // Never throw. `health` renders this result as a failing grammars line, and a broken
    // package is a gate failure.
    return [{ lang: 'manifest', ok: false, error: `missing or unreadable at ${grammarsDir}` }];
  }
  const results: { lang: string; ok: boolean; error?: string }[] = [];
  if (!Array.isArray(manifest.grammars)) {
    // A malformed shape (a bad edit or merge) must fail the gate and must not crash `health`.
    return [{ lang: 'manifest', ok: false, error: `malformed manifest (no grammars array) at ${grammarsDir}` }];
  }
  for (const g of manifest.grammars) {
    try {
      await serialized(async () => {
        await Parser.init();
        await Language.load(readFileSync(join(grammarsDir, g.wasm)));
      });
      results.push({ lang: g.lang, ok: true });
    } catch (err) {
      results.push({ lang: g.lang, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Memoize a pure function of an object key, backed by a `WeakMap`. The run-wide caches share
 *  one shape: the include roots of cpp and the wildcard representatives of java. Each cache
 *  computes one value per object that identifies an extract (a census `Set` or the
 *  module-to-file `Map` of the importer), and no value goes stale across runs, because the key
 *  dies with the extract. The compute function of the caller must be pure in its key. */
export function memoizeWeak<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    // Use `has` and not `get === undefined`. A stored `undefined` is indistinguishable from a
    // miss with a sentinel from `get`, so the code would run compute again on every call.
    if (cache.has(key)) return cache.get(key)!;
    const v = compute(key);
    cache.set(key, v);
    return v;
  };
}

/** The resolution facts that every language importer uses. This is one object instead of a
 *  positional parameter list, because the external `ImportContext` already set that
 *  precedent, and the internal seam grew one parameter per feature until this object
 *  absorbed them. */
export interface ResolveCtx {
  /** A map from module path to source file. The factory enriches it with the keys from
   *  `fileToModule`, the declared submodules, and the name aliases before any resolution
   *  runs. */
  moduleToFile: Map<string, string>;
  /** A map from module path to EVERY file that declares it, in census order (sorted). Mirror
   *  trees share keys: `android/guava/src` and `guava/src` in guava declare identical FQNs. A
   *  language with FQNs resolves through this map with `nearestCandidate`, so the twin in the
   *  same tree wins, instead of through the winner map. A language with path keys (rust, go,
   *  cpp, ts) never collides, because it has one entry per file. */
  moduleCandidates: Map<string, string[]>;
  /** The path of every code file. A `mod x;` lookup uses it to find a sibling target. */
  files: ReadonlySet<string>;
  /** The package names of the workspace member crates (rust). A bare first segment that
   *  matches one of them is an internal import across crates. A bare first segment that
   *  matches none is external (such as serde) and is silently dropped. */
  crateNames: ReadonlySet<string>;
  /** The chains of pub-use re-exports: module to alias to absolute target. The language
   *  registers both the namespaced keys and the crate-name keys itself, because the crate
   *  semantics belong to the language and not to the factory. The map is complete when
   *  `resolveEdges` runs. */
  reexports: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The re-export aliases that point OUTSIDE the partition, such as an external crate in
   *  `pub use owo_colors;`. The map goes from module to a set of aliases. The language
   *  registers them during `analyze`. Resolution silences an import that routes through one,
   *  because the target is real but has no owned file, and to flag it as a broken local import
   *  would be a false alarm. The silencing of a compiled `.so` file follows the same principle. */
  externalReexports: ReadonlyMap<string, ReadonlySet<string>>;
  /** A map from the crate-root path to the package name in `Cargo.toml` (rust, multi-crate
   *  runs only). The `analyze` hook of the language uses it to register re-exports under the
   *  crate-name form. */
  crateNameByRoot?: ReadonlyMap<string, string | null>;
  /** Where the code lives: `.` is the working repository, and a HEAD-tree directory is used
   *  for `--diff`. */
  baseDir?: string;
  /** The code directories, already joined with `baseDir`. A disk probe for a module-root
   *  mismatch resolves against them. */
  codeDirs: string[];
  /** Scratch space per extract for the resolver probes of a language. A disk or file-set
   *  lookup that repeats across `resolveEdges` calls must memoize here, because a module-level
   *  cache leaks between extracts in the same process and different fixtures can share
   *  `codeDirs`. */
  memo: Map<string, boolean>;
}

/** The key separator of the module-to-file map. The factory joins the module-path segments
 *  with it (`${importerModule}::${path.join('::')}`). A language resolver splits and joins on
 *  a hardcoded `'::'` by convention (the `candidateKeys` of go and the look and walk probes of
 *  rust), and not on this constant. Java is the exception: it uses plain FQN keys with no
 *  separator, and the `.` stays inside the key. The coupling is conventional and not
 *  enforced, so a change to the separator needs a coordinated edit across the resolvers and
 *  the tests. To export the constant and migrate about 20 sites would cost more than a
 *  separator that nobody will change. This decision is final. */
const MODULE_SEP = '::';

/** Pick the file that declares `key` and sits in the tree of the importer. The file with the
 *  deepest shared directory prefix with `sourcePath` wins. For mirror trees, an import in
 *  `android/guava/src` must resolve to a file under `android/guava/src` and not to the desktop
 *  twin. A tie goes to the lexicographically last path, which is the last write on the sorted
 *  census, and this choice keeps the `.pyx` over `.pxd` pick and every stable single-tree
 *  pick. An empty list gives null. This is the general fix for duplicate FQN trees. */
export function nearestCandidate(candidates: string[], sourcePath: string): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDepth = -1;
  const srcDirs = sourcePath.split('/').slice(0, -1);
  for (const cand of candidates) {
    const cdirs = cand.split('/').slice(0, -1);
    let depth = 0;
    const n = Math.min(srcDirs.length, cdirs.length);
    while (depth < n && srcDirs[depth] === cdirs[depth]) depth++;
    if (depth > bestDepth || (depth === bestDepth && cand > best)) {
      bestDepth = depth;
      best = cand;
    }
  }
  return best;
}

/** A declared submodule, from `mod x;` or from an inline `mod x {}`. */
interface ModDecl {
  path: string[];
  targetFile: string | null; // null means a missing target file, so the module stays out of the map and an import of it is unresolved
}

/** A pub-use re-export that the module exposes, as module to alias to absolute target. The flag
 *  `external` marks a re-export that points OUTSIDE the partition, such as the external crate
 *  in `pub use owo_colors;`. The target is empty for such a re-export, and the factory
 *  registers it in `ctx.externalReexports` instead of the chain map, so resolution silences
 *  the imports that route through it. */
export interface Reexport {
  module: string;
  alias: string;
  target: string;
  external?: boolean;
}

/** What one AST analysis pass extracts: the declared submodules, the pub-use re-exports, and
 *  every use path. The shape of a use path is language-specific and lives in `uses`. */
interface Analysis<U> {
  mods: ModDecl[];
  reexports: Reexport[];
  uses: U;
}

/** The spec of a tree-sitter language importer: the language-specific pieces. The spec has two
 *  hooks. `analyze` runs one AST walk and reports which imports exist. `resolveEdges` holds
 *  the semantics that decide where the imports land. A new language implements both hooks, and
 *  the factory runs one uniform flow for every language: parse one time, analyze one time, and
 *  resolve from the facts. */
export interface TreeSitterImporterSpec<U = unknown> {
  /** The human name for an error message, for example "rust". */
  name: string;
  extensions: readonly string[];
  wasmBasename: string;
  fileToModule(path: string, moduleRoot?: string, baseDir?: string): string;
  /** Optional: a module key that comes from the content. A language whose identity lives in
   *  the FILE and not in the path derives its key here (java from the package declaration, and
   *  kotlin and scala would do the same). The map-build loop calls this hook first and falls
   *  back to `fileToModule` when the hook returns undefined. Undefined is also the honest
   *  answer for a file with NO key, such as a default-package class in java, which is not
   *  importable from anywhere. In that case the factory keeps the `fileToModule` fallback key,
   *  which resolution never consults. A language with path identity skips the hook. */
  moduleKeyOf?(file: SourceFile, moduleRoot?: string, baseDir?: string): string | undefined;
  /** Optional: a transform of the content BEFORE the parse. Cython uses it to blank the
   *  `cimport` lines, so that the error recovery of tree-sitter-python cannot swallow a real
   *  from-import next to them. */
  preprocess?(content: string): string;
  /** Optional: the crate root that a file belongs to, or null for none. When a run spans
   *  MULTIPLE crates, the factory namespaces every module key by crate root, so the
   *  `crate::...` paths of two crates cannot collide in the shared module-to-file map. A
   *  single-crate run keeps the plain keys. */
  crateRootOf?(path: string, baseDir?: string): string | null;
  /** The package name of the crate from its manifest, with hyphens changed to underscores,
   *  which is the name that Rust sees. The factory aliases the namespaced module keys by it,
   *  so that `use sibling_crate::...` resolves. */
  crateNameOf?(crateRoot: string, baseDir?: string): string | null;
  /** Run one AST pass per file. The pass reports the declared submodules, which enrich the
   *  module-to-file map so that a deep `crate::a::b::c` path resolves, the pub-use re-exports,
   *  which register in the global chain map, and every use path, which goes to `resolveEdges`.
   *  The factory parses each file one time and runs this hook one time, so there is no second
   *  parse and no second walk. */
  analyze(root: Node, sourcePath: string, importerModule: string, ctx: ResolveCtx): Analysis<U>;
  /** Resolve the uses that the factory extracted from one file to edges from file to file and
   *  to unresolved local imports. The hook is pure over the facts from `analyze`, and
   *  `ctx.reexports` is complete when the hook runs. */
  resolveEdges(uses: U, sourcePath: string, importerModule: string, ctx: ResolveCtx): { edges: ImportEdge[]; unresolved: UnresolvedImport[] };
}

/**
 * Build an `Importer` from a tree-sitter spec. The function owns the shared loop scaffolding:
 * it builds the module-to-file map, parses each matching file one time, runs the `analyze`
 * hook of the spec (one AST walk), enriches the map from the mods and the re-exports, and then
 * hands the facts to `resolveEdges`. The factory removes a self-loop and a duplicate target.
 * It also frees each `Tree` that the WASM backs.
 */
export function createTreeSitterImporter<U = unknown>(spec: TreeSitterImporterSpec<U>): Importer {
  const matches = (path: string) => spec.extensions.some((e) => path.endsWith(e));
  return {
    name: spec.name,
    extensions: spec.extensions,
    needsContent: true,
    async extract({ files, moduleRoot, baseDir, codeDirs }): Promise<ImportResult> {
      // Deterministic winners for a module key. Two files can map to ONE module key, as the
      // pair of `.pxd` and `.pyx` files in Python does. The last file that is set wins, so a
      // sorted order picks the same file on every run, because the order of readdir depends on
      // the OS. A `.pxd` file sorts before a `.pyx` file, so the implementation wins. The sort
      // uses code-unit order and deliberately not `localeCompare`, whose result depends on the
      // locale of the host. `ownership.ts` documents the same rule for serialization.
      files = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      // Namespace the module keys by crate root when the run spans multiple crates. Two crates
      // that both map `crate::app` to DIFFERENT files would otherwise mis-resolve an import
      // without an error.
      const pathKey = (f: SourceFile): string => spec.fileToModule(f.path, moduleRoot, baseDir);
      let moduleKey = (f: SourceFile): string => (spec.moduleKeyOf ? (spec.moduleKeyOf(f, moduleRoot, baseDir) ?? pathKey(f)) : pathKey(f));
      // Package names of the workspace member crates (rust). The factory aliases their
      // namespaced module keys by name, so `use sibling_crate::...` resolves.
      const crateNames = new Set<string>();
      let nameByRoot: Map<string, string | null> | undefined;
      let aliasByName: (key: string, root: string | null) => void = () => {};
      if (spec.crateRootOf) {
        const roots = new Set(
          files
            .filter((f) => matches(f.path))
            .map((f) => spec.crateRootOf!(f.path, baseDir))
            .filter((r): r is string => r !== null),
        );
        if (roots.size > 1) {
          // Path identity only. The crate-prefix shape (`crate::` becomes `<crate>::`) is the
          // module-key grammar of rust. A content-keyed language (the `moduleKeyOf` of java)
          // has no crate concept, and to graft `<crate>::` onto a plain FQN would forge an
          // identity. The two hooks are mutually exclusive by construction. A comment keeps
          // this honest, and no dead branch is needed.
          moduleKey = (f) => {
            const m = pathKey(f);
            const r = spec.crateRootOf!(f.path, baseDir);
            if (!r || r === '.') return m; // A crate at the scan root has no prefix.
            return m === 'crate' ? r : `${r}::${m.slice('crate::'.length)}`;
          };
          if (spec.crateNameOf) {
            // Read each manifest one time. `aliasByName` runs per file and per submodule, and
            // to read the same few `Cargo.toml` files hundreds of times synchronously would
            // dominate a big workspace scan. The map also goes to `analyze` of the spec as
            // `ctx.crateNameByRoot`, for the registration of a re-export under the crate-name
            // form.
            nameByRoot = new Map<string, string | null>();
            for (const r of roots) {
              const name = spec.crateNameOf(r, baseDir);
              nameByRoot.set(r, name);
              if (name) crateNames.add(name);
            }
            // The crate at the scan root ('.') keeps the plain `crate::...` keys, and the code
            // NEVER aliases it by name. Its name must NOT count as a workspace member. If it
            // did, a binary that references the root library by name would be classified
            // internal, would fail to resolve, and would raise a false unresolved flag. It
            // would otherwise be silently external. This case is rare, and the import stays
            // external.
            const scanRootName = roots.has('.') ? (nameByRoot.get('.') ?? null) : null;
            if (scanRootName) crateNames.delete(scanRootName);
            // A namespaced key is addressed by the crate ROOT PATH. A use addresses the crate
            // by its `Cargo.toml` NAME. Alias every key, so `headroom_core::...` becomes
            // `crates/headroom-core::...`.
            aliasByName = (key, root) => {
              if (!root || root === '.' || !nameByRoot) return;
              const name = nameByRoot.get(root);
              if (!name) return;
              const prefix = `${root}::`;
              let rest: string | null = null;
              if (key === root) rest = '';
              else if (key.startsWith(prefix)) rest = key.slice(prefix.length);
              if (rest === null) return;
              const alias = rest ? `${name}::${rest}` : name;
              if (!moduleToFile.has(alias)) addModule(alias, moduleToFile.get(key)!);
            };
          }
        }
      }
      const moduleToFile = new Map<string, string>();
      const moduleCandidates = new Map<string, string[]>();
      // A map from module path to the file, which keeps EVERY declarer. The winner map uses
      // last-write-wins for the languages with path keys. The candidates map keeps all files
      // for an FQN collision: the mirror trees of guava fabricated thousands of edges when the
      // resolver picked whichever tree won the sorted walk. At resolve time, `nearestCandidate`
      // picks the twin in the same tree.
      const addModule = (key: string, file: string): void => {
        moduleToFile.set(key, file);
        const arr = moduleCandidates.get(key);
        if (arr) {
          if (!arr.includes(file)) arr.push(file);
        } else {
          moduleCandidates.set(key, [file]);
        }
      };
      for (const f of files) {
        if (!matches(f.path)) continue;
        const key = moduleKey(f);
        addModule(key, f.path);
        aliasByName(key, spec.crateRootOf?.(f.path, baseDir) ?? null);
      }

      const parser = await getGrammarParser(spec.wasmBasename);
      // The parse and the ownership of the tree. The `Tree` is backed by WASM, so the caller
      // must call `delete()` on it.
      const parse = (content: string): Tree | null => {
        const tree = parser.parse(content);
        return tree ?? null;
      };

      // Phase 1: one parse and one analyze walk per file. A declared submodule enriches the
      // module-to-file map, a re-export registers in the chain map, and a use is stashed for
      // phase 2. The enrichment MUST come before any resolution, because a use in file A can
      // target a module that file B declares. This ordering is why extraction has two phases,
      // but each file is parsed and walked exactly one time across both phases.
      const reexportMap = new Map<string, Map<string, string>>();
      const externalReexports = new Map<string, Set<string>>();
      const ctx: ResolveCtx = {
        moduleToFile,
        moduleCandidates,
        files: new Set(files.map((f) => f.path)),
        crateNames,
        reexports: reexportMap,
        externalReexports,
        crateNameByRoot: nameByRoot,
        baseDir,
        codeDirs,
        memo: new Map(),
      };
      const analyses = new Map<string, Analysis<U>>();
      for (const f of files) {
        if (!matches(f.path)) continue;
        const tree = parse(spec.preprocess ? spec.preprocess(f.content) : f.content);
        if (!tree) continue;
        try {
          const importerModule = moduleKey(f);
          const a = spec.analyze(tree.rootNode, f.path, importerModule, ctx);
          analyses.set(f.path, a);
          const root = spec.crateRootOf?.(f.path, baseDir) ?? null;
          for (const m of a.mods) {
            const key = `${importerModule}${MODULE_SEP}${m.path.join(MODULE_SEP)}`;
            // A null target is a `mod x;` whose file does not exist. Leave the module out of
            // the map, so an import of it stays unresolved instead of pointing at the file
            // that declares it. The alias needs the same guard: it reads the map entry back.
            if (m.targetFile !== null) {
              addModule(key, m.targetFile);
              aliasByName(key, root);
            }
          }
          for (const r of a.reexports) {
            if (r.external) {
              // The re-export points outside the partition. Resolution silences the imports
              // that route through it, because the target is real code but no owned file
              // exists to draw an edge to.
              let s = externalReexports.get(r.module);
              if (!s) {
                s = new Set();
                externalReexports.set(r.module, s);
              }
              s.add(r.alias);
              continue;
            }
            let m = reexportMap.get(r.module);
            if (!m) {
              m = new Map();
              reexportMap.set(r.module, m);
            }
            if (!m.has(r.alias)) m.set(r.alias, r.target);
          }
        } finally {
          tree.delete(); // A Tree of web-tree-sitter is backed by WASM, so free each one to avoid a leak.
        }
      }

      // Phase 2: resolve from the stashed facts, with no re-parse and no re-walk.
      const edges: ImportEdge[] = [];
      const unresolved: UnresolvedImport[] = [];
      for (const f of files) {
        if (!matches(f.path)) continue;
        const a = analyses.get(f.path);
        if (!a) continue;
        const { edges: fileEdges, unresolved: fileUnresolved } = spec.resolveEdges(a.uses, f.path, moduleKey(f), ctx);
        const seen = new Set<string>();
        for (const e of fileEdges) {
          if (e.toFile !== f.path && !seen.has(e.toFile)) {
            seen.add(e.toFile);
            edges.push(e);
          }
        }
        unresolved.push(...fileUnresolved);
      }
      return { edges, unresolved };
    },
  };
}
