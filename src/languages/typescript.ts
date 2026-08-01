import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { cruise, type ICruiseOptions, type ICruiseResult } from 'dependency-cruiser';
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
  // Divergent layouts: vite's exports map `./module-runner` → `dist/node/module-runner.js` but
  // the source is `src/module-runner/` (rollup flattens `node/` away). Try src/<last-segment>
  // (dropping the intermediate dirs the bundler rolled up) as well.
  let flatSrc: string | null = null;
  const flatIdx = toPosix.lastIndexOf('dist/');
  if (flatIdx >= 0) {
    const afterDist = toPosix.slice(flatIdx + 'dist/'.length);
    const lastSeg = afterDist.includes('/') ? afterDist.slice(afterDist.lastIndexOf('/') + 1) : afterDist;
    flatSrc = `${toPosix.slice(0, flatIdx)}src/${lastSeg}`;
  }
  const flatBase = flatSrc ? flatSrc.replace(/\.js$/, '') : null; // strip the ext — the source may be a dir (index.ts)
  const candidates = [
    toPosix,
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
    ...(flatBase ? [flatSrc!, flatBase, `${flatBase}.ts`, `${flatBase}/index.ts`, `${flatBase}/index.tsx`] : []),
  ];
  for (const c of candidates) {
    if (existsSync(join(baseDir, c))) {
      cache.set(key, norm(join(baseDir, c)));
      return norm(join(baseDir, c));
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
        try {
          const cfg = JSON.parse(readFileSync(tsPath, 'utf8')) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
          const paths = cfg.compilerOptions?.paths;
          if (paths) {
            const base = cfg.compilerOptions?.baseUrl && cfg.compilerOptions.baseUrl !== '.' ? posix.normalize(`${dir}/${cfg.compilerOptions.baseUrl}`) : dir;
            for (const [alias, targets] of Object.entries(paths)) {
              mergeAlias(alias, targets.map((t) => posix.normalize(`${base}/${t}`)));
            }
          }
        } catch {
          /* malformed nested tsconfig — skip; its aliases stay unresolved */
        }
      }
      dir = dirname(dir);
    }
  }
  // the root tsconfig itself: read its paths too (files at the repo root never enter the loop)
  const rootPath = join(baseDir, 'tsconfig.json');
  if (existsSync(rootPath)) {
    try {
      const cfg = JSON.parse(readFileSync(rootPath, 'utf8')) as { compilerOptions?: { paths?: Record<string, string[]> } };
      for (const [alias, targets] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
        mergeAlias(alias, targets.map((t) => posix.normalize(t)));
      }
    } catch {
      /* skip */
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
    // 3) heuristic: entry dir + rest (extension/index probes)
    const entryDir = pkg.entry ? pkg.entry.slice(0, pkg.entry.lastIndexOf('/')) : pkg.dir;
    const t = probeFile(baseDir, norm, join(entryDir, rest), cache);
    if (t) return { matched: true, toFile: t };
    // Known package with an entry whose subpath is absent → broken local import (flag).
    // No entry at all (dist-only, no source) → can't judge — stay silent like an external.
    return { matched: pkg.entry !== null, toFile: null };
  }
  return { matched: false, toFile: null };
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
      try {
        if (existsSync(tsConfigPath)) Object.assign(cfg, JSON.parse(readFileSync(tsConfigPath, 'utf8')) as Record<string, unknown>);
      } catch {
        /* unreadable root tsconfig — synthesize from the merged paths alone */
      }
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
      const { output } = await cruise(dirs, cruiseOpts); // guard the shape — a future cruise() default that stops returning the result object
      // would silently fake an empty graph (false green) if unchecked
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
          } else if (dep.module.startsWith('.') || dep.module.startsWith('@/') || dep.module.startsWith('~/')) {
            // Relative specifiers and alias prefixes that can't resolve look local — likely
            // a broken import or a missing tsconfig `paths` mapping. Bare specifiers
            // (e.g. 'react', '@scope/pkg') are external packages — skip silently.
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
