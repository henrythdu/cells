import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { cruise, type ICruiseOptions, type ICruiseResult } from 'dependency-cruiser';
import ts from 'typescript';
import type { ImportEdge, ImportResult, UnresolvedImport, Importer, SourceFile } from '../imports.js';

/** A workspace package: its dir (repo-relative), parsed `exports` (for subpath keys), and the
 *  resolved `.` entry source file (or null). */
interface PkgInfo {
  dir: string;
  exports: Record<string, unknown> | null;
  entry: string | null;
}

/** First string in a conditional-exports object, recursing into nested conditionals
 *  (types/import/module/default priority). Pure. */
function firstString(obj: Record<string, unknown>): string | undefined {
  for (const k of ['types', 'import', 'module', 'default']) {
    const v = obj[k];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) return firstString(v as Record<string, unknown>);
  }
  return undefined;
}

/** Probe a repo-relative target with extension/index + dist→src variants (so a dist-only `main`
 *  lands on the source file). Returns the first existing file (repo-relative), else null.
 *  Probe results are memoized per extract — monorepos without node_modules issue hundreds of
 *  bare-specifier lookups and re-stat the same candidate paths repeatedly. Pure wrt inputs. */
function probeFile(baseDir: string, norm: (p: string) => string, rel: string, cache: Map<string, string | null>): string | null {
  const key = `${baseDir}\u0000${rel}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const toPosix = rel.replace(/\\/g, '/'); // win32: join/relative emit backslashes; string ops below need /
  // `dist/` at any depth → `src/` (a package's dist entry maps to its source tree)
  const srcRel = toPosix.replace(/(^|\/)dist\//, '$1src/');
  const candidates = [
    toPosix,
    `${toPosix}.d.ts`, // types-only exports resolve to declaration files (vite/types/*)
    `${toPosix}.ts`,
    `${toPosix}.tsx`,
    `${toPosix}/index.ts`,
    `${toPosix}/index.tsx`,
    toPosix.replace(/\.js$/, '.ts'),
    srcRel,
    `${srcRel}.ts`,
    `${srcRel}.tsx`,
    `${srcRel}/index.ts`,
    `${srcRel}/index.tsx`,
    srcRel.replace(/\.js$/, '.ts'),
    // directory targets (`require('..')` → the dir's index): plain JS-family index files
    `${toPosix}/index.js`,
    `${toPosix}/index.jsx`,
    `${toPosix}/index.mjs`,
    `${toPosix}/index.cjs`,
  ];
  for (const c of candidates) {
    const full = join(baseDir, c);
    try {
      if (statSync(full).isFile()) {
        cache.set(key, norm(full));
        return norm(full);
      }
    } catch {
      /* not found or not a file — try the next candidate */
    }
  }
  cache.set(key, null);
  return null;
}

/** A package.json's exports/subpath target as a source file, or null. Pure. */
function exportsTarget(exports: Record<string, unknown> | null, key: string): string | null {
  if (!exports) return null;
  const v = exports[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) return firstString(v as Record<string, unknown>) ?? null;
  return null;
}

/**
 * Workspace package map: package.json `name` → PkgInfo. Built from the ancestor chain of
 * every code file (a file's nearest package.json owns it) — so packages with no code in
 * code-dirs never enter the map, and the root repo package.json (dir '.') is never read.
 */
function workspacePackages(files: SourceFile[], baseDir: string, norm: (p: string) => string, cache: Map<string, string | null>): Map<string, PkgInfo> {
  const map = new Map<string, PkgInfo>();
  const seen = new Set<string>();
  for (const f of files) {
    let dir = dirname(f.path);
    while (dir !== '.' && !seen.has(dir)) {
      seen.add(dir);
      const pj = join(baseDir, dir, 'package.json');
      if (existsSync(pj)) {
        try {
          const pkg = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, unknown>;
          const name = typeof pkg.name === 'string' ? pkg.name : undefined;
          if (name && !map.has(name)) {
            const exports = pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) ? (pkg.exports as Record<string, unknown>) : null;
            const dot = exportsTarget(exports, '.');
            let main: string | undefined;
            if (typeof pkg.main === 'string') main = pkg.main;
            else if (typeof pkg.types === 'string') main = pkg.types;
            const entry = probeFile(baseDir, norm, join(dir, (dot ?? main ?? 'src/index.ts').replace(/^\.\//, '')), cache);
            map.set(name, { dir, exports, entry });
          }
        } catch {
          /* malformed package.json — skip; the package's imports stay external */
        }
        break; // nearest package owns the file; don't walk past it
      }
      dir = dirname(dir);
    }
  }
  return map;
}

/** An exports wildcard key matching the subpath (e.g. `./features/*` matches `features/x`,
 *  `./*` matches anything) with `*` substituted by the subpath — or null. Pure. */
function wildcardTarget(exports: Record<string, unknown> | null, rest: string): string | null {
  if (!exports) return null;
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star); // './features/' (keys carry the leading './')
    if (prefix.length < 2 || !rest.startsWith(prefix.slice(2))) continue;
    const target = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) ? firstString(value as Record<string, unknown>) : undefined;
    if (typeof target !== 'string' || !target.includes('*')) continue;
    return target.replace('*', rest.slice(prefix.length - 2));
  }
  return null;
}

/** Parse a tsconfig.json. TS config files are jsonc by spec — comments and trailing commas
 *  are legal (turborepo's apps/web/tsconfig.json has a trailing comma in `paths`); strict
 *  JSON.parse would throw and silently drop the config, losing its `paths` aliases.
 *  ts.readConfigFile handles comments/trailing commas/BOM natively. Returns null on
 *  read/parse failure (same contract as the old try/catch JSON.parse). */
function readTsconfig(filePath: string): Record<string, unknown> | null {
  const result = ts.readConfigFile(filePath, ts.sys.readFile);
  return result.error ? null : ((result.config as Record<string, unknown> | undefined) ?? null);
}

/**
 * Collect `paths` aliases from every tsconfig.json found along the code-file ancestor walk
 * (root + nested per-app configs), rewritten to repo-root-relative targets (a nested
 * tsconfig's paths are relative to its own dir). Alias → root-relative targets. Reads the
 * files once per unique dir; malformed configs skipped. Pure wrt inputs (FS reads).
 */
function collectTsconfigPaths(files: SourceFile[], baseDir: string): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  /** Merge one alias' root-relative targets, deduping across configs. */
  const mergeAlias = (alias: string, targets: string[]): void => {
    const existing = merged.get(alias);
    if (existing) {
      for (const t of targets) if (!existing.includes(t)) existing.push(t);
    } else {
      merged.set(alias, targets);
    }
  };
  const seen = new Set<string>();
  for (const f of files) {
    let dir = dirname(f.path);
    while (dir !== '.' && !seen.has(dir)) {
      seen.add(dir);
      const tsPath = join(baseDir, dir, 'tsconfig.json');
      if (existsSync(tsPath)) {
        const cfg = readTsconfig(tsPath) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | null;
        const paths = cfg?.compilerOptions?.paths;
        if (paths) {
          const base = cfg.compilerOptions?.baseUrl && cfg.compilerOptions.baseUrl !== '.' ? posix.normalize(`${dir}/${cfg.compilerOptions.baseUrl}`) : dir;
          for (const [alias, targets] of Object.entries(paths)) {
            mergeAlias(
              alias,
              targets.map((t) => posix.normalize(`${base}/${t}`)),
            );
          }
        }
      }
      dir = dirname(dir);
    }
  }
  // the root tsconfig itself: read its paths too (files at the repo root never enter the loop)
  const rootPath = join(baseDir, 'tsconfig.json');
  if (existsSync(rootPath)) {
    const cfg = readTsconfig(rootPath) as { compilerOptions?: { paths?: Record<string, string[]> } } | null;
    for (const [alias, targets] of Object.entries(cfg?.compilerOptions?.paths ?? {})) {
      mergeAlias(
        alias,
        targets.map((t) => posix.normalize(t)),
      );
    }
  }
  return merged;
}

/** Resolve a bare specifier against the workspace map: exact name → entry; `name/rest` via
 *  exports subpath keys, wildcard keys, then entry-dir + rest probes. `matched` distinguishes
 *  a broken local subpath (flag) from a genuinely external package (silent). Pure. */
function resolvePackageSpec(spec: string, map: Map<string, PkgInfo>, baseDir: string, norm: (p: string) => string, cache: Map<string, string | null>): { matched: boolean; toFile: string | null } {
  const parts = spec.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const name = parts.slice(0, i).join('/');
    const pkg = map.get(name);
    if (!pkg) continue;
    const rest = parts.slice(i).join('/');
    if (!rest) return { matched: true, toFile: pkg.entry };
    // 1) exact exports subpath key (e.g. exports["./with-module"])
    const exact = exportsTarget(pkg.exports, `./${rest}`);
    if (exact) {
      const t = probeFile(baseDir, norm, join(pkg.dir, exact.replace(/^\.\//, '')), cache);
      if (t) return { matched: true, toFile: t };
    }
    // 2) wildcard exports key (e.g. exports["./*"] = "./src/*" or "./features/*")
    const wild = wildcardTarget(pkg.exports, rest);
    if (wild) {
      const t = probeFile(baseDir, norm, join(pkg.dir, wild.replace(/^\.\//, '')), cache);
      if (t) return { matched: true, toFile: t };
    }
    // 3) heuristic: no exports field → Node semantics — `name/rest` resolves to
    //    <pkgdir>/rest (stress #16: @turbo/utils/src/get-turbo-configs →
    //    packages/turbo-utils/src/get-turbo-configs.ts; the old entry-dir probe
    //    looked in src/src/ and flagged a resolvable import as broken). With
    //    exports, subpaths live under the entry's dir (the ./subpath shape).
    const entryDir = pkg.entry ? pkg.entry.slice(0, pkg.entry.lastIndexOf('/')) : pkg.dir;
    const base = pkg.exports ? entryDir : pkg.dir;
    const t = probeFile(baseDir, norm, join(base, rest), cache);
    if (t) return { matched: true, toFile: t };
    // Known package with an entry whose subpath is absent → broken local import (flag).
    // No entry at all (dist-only, no source) → can't judge — stay silent like an external.
    return { matched: pkg.entry !== null, toFile: null };
  }
  return { matched: false, toFile: null };
}

/** Probe a relative specifier (./x, ../x, '.', '..') that dep-cruiser couldn't resolve.
 *  Two common misses: directory imports (`require('..')` → the dir's index.*) and imports of
 *  dist artifacts (source importing its own build output — the probe's dist→src variants land
 *  on the source file). Resolves against the importing file's dir, then shares the standard
 *  probe (ext/index/dist→src variants). Returns the probed source file or null. Pure. */
function resolveRelativeImport(spec: string, source: string, baseDir: string, norm: (p: string) => string, cache: Map<string, string | null>): string | null {
  const target = posix.normalize(posix.join(posix.dirname(source), spec)).replace(/\/$/, '');
  return probeFile(baseDir, norm, target, cache);
}

/** dep-cruiser importer — TS/JS. Source-based; handles aliases and `.js`→`.ts`. */
export const depCruiserImporter: Importer = {
  name: 'typescript',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
  async extract({ codeDirs, baseDir, files }): Promise<ImportResult> {
    const dirs = codeDirs.map((d) => (d.endsWith('/') ? d : `${d}/`));
    const cruiseOpts: ICruiseOptions = {
      tsPreCompilationDeps: true,
      doNotFollow: { path: 'node_modules' },
    };
    // Point dep-cruiser at the repo tsconfig explicitly — its auto-discovery misses it when
    // cruising a subdir (src/), which silently drops `paths` alias imports (`@/x`) as unresolved.
    const root = baseDir && baseDir !== '.' ? baseDir : process.cwd();
    const tsConfigPath = join(root, 'tsconfig.json');
    // wave-3 #3: nested per-app tsconfigs (turborepo's apps/*/tsconfig.json, Next.js `@/*`
    // aliases) are invisible to dep-cruiser's single-config view. Merge every tsconfig found
    // along the code-file ancestor walk into one synthesized config with root-relative paths.
    const mergedPaths = collectTsconfigPaths(files ?? [], baseDir ?? '.');
    let tempDir: string | null = null;
    if (mergedPaths.size > 0) {
      const cfg: Record<string, unknown> = { compilerOptions: {} };
      if (existsSync(tsConfigPath)) Object.assign(cfg, readTsconfig(tsConfigPath) ?? {});
      const co = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
      co.paths = { ...((co.paths as Record<string, unknown>) ?? {}), ...Object.fromEntries(mergedPaths) };
      cfg.compilerOptions = co;
      tempDir = mkdtempSync(join(tmpdir(), 'cells-tsc-'));
      const mergedPath = join(tempDir, 'tsconfig.json');
      // The temp config lives in tmpdir, but paths targets are repo-root-relative — point
      // baseUrl back at the repo root or TS resolves them against the temp dir (missing).
      // Platform-aware relative: posix.relative on Windows treats \ as a literal char.
      co.baseUrl = relative(tempDir, root);
      writeFileSync(mergedPath, JSON.stringify(cfg));
      cruiseOpts.tsConfig = { fileName: mergedPath };
    } else if (existsSync(tsConfigPath)) {
      cruiseOpts.tsConfig = { fileName: tsConfigPath };
    }
    let result: ICruiseResult;
    try {
      // guard the shape — a future cruise() default that stops returning the result object
      // would silently fake an empty graph (false green) if unchecked
      const { output } = await cruise(dirs, cruiseOpts);
      if (typeof output !== 'object' || output === null || !Array.isArray((output as ICruiseResult).modules)) {
        throw new Error('dependency-cruiser returned a non-JSON result');
      }
      result = output as ICruiseResult;
    } catch (err) {
      // dep-cruiser couldn't handle the paths/language — surface it; silent zero-edges
      // would fake a green gate on a blind graph. (collectImportEdges turns this into
      // a gate failure.)
      throw new Error(`dependency-cruiser failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // the synthesized tsconfig lives in a throwaway temp dir — never leak one per run
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    }
    // dep-cruiser emits paths relative to cwd; when cruising a HEAD tree (baseDir) remap them
    // to repo-relative so they match ownership. (Tree-sitter importers already emit repo-relative.)
    const cwd = process.cwd();
    const norm = (p: string): string => {
      const n = p.replace(/^\.\//, '');
      return baseDir && baseDir !== '.' ? relative(baseDir, resolve(cwd, n)) : n;
    };
    const probeCache = new Map<string, string | null>();
    const pkgEntries = workspacePackages(files ?? [], baseDir ?? '.', norm, probeCache);
    const edges: ImportEdge[] = [];
    const unresolved: UnresolvedImport[] = [];
    for (const mod of result.modules ?? []) {
      for (const dep of mod.dependencies ?? []) {
        if (dep.couldNotResolve) {
          // Workspace package-name imports (`@turbo/utils`) — the TS analog of Rust crate
          // names: unresolvable without node_modules, so dep-cruiser reports them; we map
          // them to the package entry source. A known name with an unknown subpath is a
          // broken local import (flag); a name no package owns is external — silent.
          const pkg = resolvePackageSpec(dep.module, pkgEntries, baseDir ?? '.', norm, probeCache);
          if (pkg.matched) {
            if (pkg.toFile) edges.push({ fromFile: norm(mod.source), toFile: pkg.toFile, import: dep.module });
            else unresolved.push({ fromFile: norm(mod.source), import: dep.module });
          } else if (dep.module.startsWith('.')) {
            // Relative specifier dep-cruiser couldn't resolve — probe the target ourselves
            // (dir-index + dist→src variants): `require('..')` and source→dist imports don't
            // resolve through dep-cruiser's default module resolution.
            const t = resolveRelativeImport(dep.module, norm(mod.source), baseDir ?? '.', norm, probeCache);
            if (t) edges.push({ fromFile: norm(mod.source), toFile: t, import: dep.module });
            else unresolved.push({ fromFile: norm(mod.source), import: dep.module });
          } else if (dep.module.startsWith('@/') || dep.module.startsWith('~/') || dep.module.startsWith('#/')) {
            // Alias prefixes that can't resolve look local — likely a broken import or a
            // missing tsconfig `paths` mapping (@/ ~/ are the webpack/vite convention; #/ is
            // Nuxt/Nitro's). Bare specifiers (e.g. 'react', '@scope/pkg') are external
            // packages — skip silently.
            unresolved.push({ fromFile: norm(mod.source), import: dep.module });
          }
          continue;
        }
        if (dep.coreModule) continue; // node built-in
        if (dep.matchesDoNotFollow) continue; // external package (node_modules) — keep the graph to repo files
        if (!dep.resolved) continue;
        edges.push({
          fromFile: norm(mod.source),
          toFile: norm(dep.resolved),
          import: dep.module,
        });
      }
    }
    return { edges, unresolved };
  },
};
