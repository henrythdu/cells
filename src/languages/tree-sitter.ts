import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, type Node, Parser, type Tree } from 'web-tree-sitter';
import type { ImportEdge, ImportResult, SourceFile, UnresolvedImport, Importer } from '../imports.js';
/**
 * Shared tree-sitter importer infrastructure: a grammar-WASM singleton cache +
 * a factory that owns the parse loop. Each language importer supplies only its
 * language-specific logic (module derivation, AST extraction, resolution).
 */

// --- grammar singleton cache (one Parser per grammar WASM; lazy + memoized) ---
const parsers = new Map<string, Promise<Parser>>();

// Serialize grammar loading: web-tree-sitter's Language.load shares WASM state, and two
// concurrent loads race it (one grammar loads corrupted → silent empty extraction). This
// chain makes loads strictly sequential even if callers parallelize; the chain survives
// individual failures so a broken grammar doesn't wedge the others.
let loadChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = loadChain.then(fn);
  loadChain = run.catch(() => {});
  return run;
}

/** Load (once) + cache the tree-sitter Parser for a bundled grammar WASM. */
export function getGrammarParser(wasmBasename: string): Promise<Parser> {
  let p = parsers.get(wasmBasename);
  if (!p) {
    p = serialized(async () => {
      await Parser.init();
      // WASMs ship as static assets in grammars/ (built ABI-matched to web-tree-sitter;
      // the prebuilt tree-sitter-wasms pack is OLD-CLI/incompatible — see memory 155).
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
    p.catch(() => parsers.delete(wasmBasename)); // don't cache the rejection — allow retry on the next call
  }
  return p;
}

/** Verify the bundled grammar set (grammars/manifest.json): every declared wasm exists in
 *  the package and loads against the bundled runtime — the authoritative ABI check. A missing
 *  file or ABI mismatch here means the package is broken even if no repo currently has files
 *  of that language (the lazy per-language failure would otherwise stay silent). Called by
 *  `cells health`; runs loads through the same serialized chain as real parsing, so it can't
 *  race concurrent grammar loads. */
export async function checkGrammars(): Promise<{ lang: string; ok: boolean; error?: string }[]> {
  const grammarsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'grammars');
  let manifest: { grammars: { lang: string; wasm: string }[] };
  try {
    manifest = JSON.parse(readFileSync(join(grammarsDir, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    // never throw — health renders this as a failing grammars line (broken package = gate failure)
    return [{ lang: 'manifest', ok: false, error: `missing or unreadable at ${grammarsDir}` }];
  }
  const results: { lang: string; ok: boolean; error?: string }[] = [];
  if (!Array.isArray(manifest.grammars)) {
    // malformed shape (bad edit/merge) must fail the gate, not crash health
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

/** Spec for a tree-sitter language importer: the language-specific pieces. */
export interface TreeSitterImporterSpec {
  /** Human name for error messages (e.g. "rust"). */
  name: string;
  extensions: readonly string[];
  wasmBasename: string;
  fileToModule(path: string, moduleRoot?: string, baseDir?: string): string;
  /** Optional: the crate root a file belongs to (null = none). When a run spans MULTIPLE
   *  crates, the factory namespaces every module key by crate root so two crates' `crate::…`
   *  paths can't collide in the shared module→file map (single-crate runs keep plain keys). */
  crateRootOf?(path: string, baseDir?: string): string | null;
  /** The crate's package name from its manifest (hyphens→underscores — the Rust-visible name).
   *  The factory aliases namespaced module keys by it so `use sibling_crate::…` resolves. */
  crateNameOf?(crateRoot: string, baseDir?: string): string | null;
  /** Declared submodules with their module-path chain relative to the containing file,
   *  e.g. `mod x;` → [['x'], 'x.rs'], inline `mod x {}` → [['x'], null] (lives in this file),
   *  nested inline blocks → [['x','y'], null]. null targetFile = inline block. The factory
   *  enriches the module→file map with these so deep `crate::a::b::c` paths resolve to the
   *  file containing the deepest module instead of reporting false "unresolved". */
  declareModules?(root: Node, sourcePath: string, fileSet: Set<string>): { path: string[]; targetFile: string | null }[];
  /** Pub-use re-exports: the alias a module exposes (`pub use service::osv` → osv at this
   *  module, absolute target `crate::service::osv`). The factory merges these into a global
   *  map passed to extractEdges, so imports through re-export chains resolve. */
  collectReexports?(root: Node, importerModule: string, crateNames: ReadonlySet<string>): { module: string; alias: string; target: string }[];
  /** Parse a tree's root into import edges + unresolved local imports (extraction + resolution).
   *  Self-loops and duplicate targets are de-duped by the factory. `crateNames` = the package
   *  names of workspace member crates — a bare first segment matching one is a cross-crate
   *  internal import (vs a silently-dropped external like `serde`). */
  extractEdges(
    root: Node,
    sourcePath: string,
    importerModule: string,
    moduleToFile: Map<string, string>,
    crateNames?: ReadonlySet<string>,
    reexports?: ReadonlyMap<string, ReadonlyMap<string, string>>,
  ): { edges: ImportEdge[]; unresolved: UnresolvedImport[] };
}

/**
 * Build an Importer from a tree-sitter spec. Owns the shared loop scaffolding:
 * build the module→file map, parse each matching file, hand the tree to
 * `extractEdges`, de-dupe, and free each WASM-backed Tree. The per-language
 * logic lives in the spec; this is the language-agnostic engine.
 */
export function createTreeSitterImporter(spec: TreeSitterImporterSpec): Importer {
  const matches = (path: string) => spec.extensions.some((e) => path.endsWith(e));
  return {
    name: spec.name,
    extensions: spec.extensions,
    needsContent: true,
    async extract({ files, moduleRoot, baseDir }): Promise<ImportResult> {
      // Namespace module keys by crate root when the run spans multiple crates — two crates
      // both mapping `crate::app` to DIFFERENT files would silently mis-resolve imports.
      let moduleKey = (f: SourceFile): string => spec.fileToModule(f.path, moduleRoot, baseDir);
      // Package names of workspace member crates — the factory aliases their namespaced
      // module keys by name so `use sibling_crate::…` resolves (rust.ts crates only).
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
          moduleKey = (f) => {
            const m = spec.fileToModule(f.path, moduleRoot, baseDir);
            const r = spec.crateRootOf!(f.path, baseDir);
            if (!r || r === '.') return m; // scan-root crate — no prefix
            return m === 'crate' ? r : `${r}::${m.slice('crate::'.length)}`;
          };
          if (spec.crateNameOf) {
            // Read each manifest ONCE — aliasByName runs per file/submodule, and re-reading
            // the same few Cargo.tomls hundreds of times synchronously would dominate a big
            // workspace scan. Hoisted to function scope — reexports registration needs it too.
            nameByRoot = new Map<string, string | null>();
            for (const r of roots) {
              const name = spec.crateNameOf(r, baseDir);
              nameByRoot.set(r, name);
              if (name) crateNames.add(name);
            }
            // The scan-root crate ('.') keeps plain `crate::…` keys — it is NEVER aliased by
            // name. Its name must NOT count as a workspace member: a bin referencing the root
            // lib by name would otherwise classify internal, fail to resolve, and false-flag as
            // unresolved (it was silently external before). Rare; stays external, as pre-fix.
            const scanRootName = roots.has('.') ? (nameByRoot.get('.') ?? null) : null;
            if (scanRootName) crateNames.delete(scanRootName);
            // Namespaced keys are addressed by crate ROOT PATH; a use addresses the crate by
            // its Cargo.toml NAME. Alias every key so `headroom_core::…` → `crates/headroom-core::…`.
            aliasByName = (key, root) => {
              if (!root || root === '.') return;
              const name = nameByRoot!.get(root);
              if (!name) return;
              const prefix = `${root}::`;
              let rest: string | null = null;
              if (key === root) rest = '';
              else if (key.startsWith(prefix)) rest = key.slice(prefix.length);
              if (rest === null) return;
              const alias = rest ? `${name}::${rest}` : name;
              if (!moduleToFile.has(alias)) moduleToFile.set(alias, moduleToFile.get(key)!);
            };
          }
        }
      }
      const moduleToFile = new Map<string, string>();
      for (const f of files) {
        if (!matches(f.path)) continue;
        const key = moduleKey(f);
        moduleToFile.set(key, f.path);
        aliasByName(key, spec.crateRootOf?.(f.path, baseDir) ?? null);
      }

      const parser = await getGrammarParser(spec.wasmBasename);
      // parse + tree ownership: the Tree is WASM-backed — the caller must delete() it.
      const parse = (content: string): Tree | null => {
        const tree = parser.parse(content);
        return tree ?? null;
      };

      // Enrich the module→file map with every declared submodule (inline + `mod x;`). The
      // declared key always equals the target's own path-derived module (rust `mod x;` targets
      // are path-aligned: sibling or name/ dir), so one pass over all files is order-free.
      const reexportMap = new Map<string, Map<string, string>>();
      if (spec.declareModules || spec.collectReexports) {
        const fileSet = new Set(files.map((f) => f.path));
        for (const f of files) {
          if (!matches(f.path)) continue;
          const tree = parse(f.content);
          if (!tree) continue;
          try {
            const base = moduleKey(f);
            const root = spec.crateRootOf?.(f.path, baseDir) ?? null;
            if (spec.declareModules) {
              for (const m of spec.declareModules(tree.rootNode, f.path, fileSet)) {
                const key = `${base}::${m.path.join('::')}`;
                moduleToFile.set(key, m.targetFile ?? f.path);
                aliasByName(key, root);
              }
            }
            if (spec.collectReexports) {
              for (const r of spec.collectReexports(tree.rootNode, base, crateNames)) {
                const register = (module: string, target: string): void => {
                  let m = reexportMap.get(module);
                  if (!m) {
                    m = new Map();
                    reexportMap.set(module, m);
                  }
                  if (!m.has(r.alias)) m.set(r.alias, target);
                };
                register(r.module, r.target);
                // ALSO under the crate-NAME form: a use addresses `uv_audit::osv::Filter` by
                // name (crateNames alias), while r.module is the namespaced key.
                const name = root && root !== '.' ? nameByRoot?.get(root) : undefined;
                if (name) {
                  const target = r.target.startsWith(`${r.module}::`) || r.target === r.module ? name + r.target.slice(r.module.length) : r.target;
                  register(name, target);
                }
              }
            }
          } finally {
            tree.delete();
          }
        }
      }

      const edges: ImportEdge[] = [];
      const unresolved: UnresolvedImport[] = [];
      for (const f of files) {
        if (!matches(f.path)) continue;
        const tree = parse(f.content);
        if (!tree) continue;
        try {
          const importerModule = moduleKey(f);
          const seen = new Set<string>();
          const { edges: fileEdges, unresolved: fileUnresolved } = spec.extractEdges(tree.rootNode, f.path, importerModule, moduleToFile, crateNames, reexportMap);
          for (const e of fileEdges) {
            if (e.toFile !== f.path && !seen.has(e.toFile)) {
              seen.add(e.toFile);
              edges.push(e);
            }
          }
          unresolved.push(...fileUnresolved);
        } finally {
          tree.delete(); // web-tree-sitter Trees are WASM-backed — free each one to avoid leaking.
        }
      }
      return { edges, unresolved };
    },
  };
}
