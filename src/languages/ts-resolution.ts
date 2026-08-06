import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { ResolveCtx } from './tree-sitter.js';

/**
 * TypeScript/JS/TSX specifier resolution — the deep core shared by the three TS-family
 * importer specs (typescript.tsx/tsx/javascript). A specifier + the importing file →
 * the resolution decision: `toFile` (repo-relative) or a classification of the miss
 * (`local` = broken local import to flag, false = external/builtin to skip silently).
 *
 * Resolution semantics (ported from the dep-cruiser importer, kept behavior-identical):
 *  - relative specifiers (`./x`, `..`) probe extension/index/dist→src candidates, then draw
 *    an edge when the target is a census file; an existing non-code target (css/json) is
 *    real but silent; nothing on disk = unresolved (honest).
 *  - `@/`, `~/`, `#/` and any tsconfig `paths` alias resolve through the merged per-repo
 *    tsconfig map (jsonc-tolerant); a mapped-but-missing target = unresolved.
 *  - bare specifiers resolve through the workspace package map (package.json name → dir,
 *    `exports` exact/wildcard subpaths, then Node pkgdir+rest) — a known package with a
 *    broken subpath = unresolved; an unknown name (external dep, node builtin) = silent.
 * Source-based only: reads package.json/tsconfig.json, never executes. Resolution facts
 * (package map + alias map) build once per extract (WeakMap keyed on the factory's ctx).
 */

/** A workspace package: its dir (repo-relative), parsed `exports` (for subpath keys), and the
 *  resolved `.` entry source file (or null). */
export interface PkgInfo {
  dir: string;
  exports: Record<string, unknown> | null;
  entry: string | null;
}

/** Per-extract resolution facts: the workspace package map + per-directory tsconfig
 *  alias maps (chain-resolved). Both are pure over (census files, baseDir) and expensive to
 *  build — computed once per extract, keyed on the factory's ResolveCtx (per-extract object;
 *  GC-safe, no cross-run staleness). */
export interface TsFacts {
  packages: Map<string, PkgInfo>;
  /** config file path → chain-resolved alias map (root-relative targets); null = no config there */
  configs: Map<string, Map<string, string[]> | null>;
  /** file → its nearest config's aliases (null = none on the ancestor chain) */
  fileConfigs: Map<string, Map<string, string[]> | null>;
}

const factsByCtx = new WeakMap<ResolveCtx, TsFacts>();
export function factsOf(ctx: ResolveCtx): TsFacts {
  let f = factsByCtx.get(ctx);
  if (!f) {
    const base = ctx.baseDir ?? '.';
    f = { packages: workspacePackages(ctx.files, base, ctx, rootWorkspaceGlobs(base)), configs: new Map(), fileConfigs: new Map() };
    factsByCtx.set(ctx, f);
  }
  return f;
}

// --- tsconfig parsing (jsonc) ---

/** Strip JSONC down to strict JSON: // and /* *\/ comments + trailing commas. Careful with
 *  strings (a URL `https://x` or `//` inside a string must survive). The `typescript` package
 *  used to do this via readConfigFile — a ~20-line stripper replaces the 60MB dependency. */
function stripJsonc(s: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** Parse a tsconfig.json (jsonc: comments + trailing commas are legal). Null on failure —
 *  same contract as the old typescript.readConfigFile wrapper. */
function readTsconfig(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stripJsonc(readFileSync(filePath, 'utf8'))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One tsconfig's `paths`, chain-resolved: its own keys + its `extends` chain's keys
 * (child overrides per alias; parent aliases persist — tsc's shallow merge). Targets are
 * rewritten repo-root-relative (each config's targets are relative to ITS dir/baseUrl).
 * Package-name extends (`@tsconfig/...`) are skipped — source-based only, no node_modules
 * reads; those configs rarely carry the paths that matter. Keyed by the config FILE path:
 * extends may name any file (a same-dir tsconfig.base.json, a repo-root ../../tsconfig.json)
 * — the old dir-keyed probe re-read THIS config on same-dir extends → infinite recursion →
 * the importer died on every repo with a base config (RangeError). The visiting guard
 * (cache-set-before-recurse) additionally terminates cross-file cycles. Memoized per file.
 * Pure.
 */
function configAliases(configPath: string, baseDir: string, cache: Map<string, Map<string, string[]> | null>): Map<string, string[]> | null {
  const hit = cache.get(configPath);
  if (hit !== undefined) return hit;
  cache.set(configPath, null); // visiting guard: a cycle reads the placeholder instead of re-recursing
  let merged: Map<string, string[]> | null = null;
  if (existsSync(join(baseDir, configPath))) {
    const cfg = readTsconfig(join(baseDir, configPath)) as { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | null;
    if (cfg) {
      if (typeof cfg.extends === 'string' && !cfg.extends.startsWith('@')) {
        const ext = posix.normalize(posix.join(posix.dirname(configPath), cfg.extends));
        const parent = configAliases(ext, baseDir, cache);
        if (parent) merged = new Map(parent);
      }
      const paths = cfg.compilerOptions?.paths;
      if (paths) {
        merged ??= new Map();
        const dir = posix.dirname(configPath);
        const base = cfg.compilerOptions?.baseUrl && cfg.compilerOptions.baseUrl !== '.' ? posix.normalize(`${dir}/${cfg.compilerOptions.baseUrl}`) : dir;
        for (const [alias, targets] of Object.entries(paths)) {
          merged.set(
            alias,
            targets.map((t) => posix.normalize(`${base}/${t}`)),
          );
        }
      }
    }
  }
  cache.set(configPath, merged);
  return merged;
}

/** A file's aliases = the nearest tsconfig on its ancestor chain (tsc's owning-program model:
 *  a nested project's config shadows the root's; a merged map would cross-contaminate
 *  independent projects — e.g. one fixture's `@/` aliases applied to another's files). */
function aliasesForFile(file: string, facts: TsFacts, baseDir: string): Map<string, string[]> | null {
  const cached = facts.fileConfigs.get(file);
  if (cached !== undefined) return cached;
  let dir = dirname(file);
  let cfg = null;
  while (dir !== '.' || cfg === null) {
    cfg = configAliases(dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`, baseDir, facts.configs);
    if (cfg !== null) break;
    if (dir === '.') break;
    dir = dirname(dir);
  }
  facts.fileConfigs.set(file, cfg);
  return cfg;
}

// --- workspace package map ---

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

/** A package.json's exports/subpath target as a source file, or null. Pure. */
function exportsTarget(exports: Record<string, unknown> | null, key: string): string | null {
  if (!exports) return null;
  const v = exports[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) return firstString(v as Record<string, unknown>) ?? null;
  return null;
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
 * Root workspace globs: package.json `workspaces` (npm array | yarn {packages}) or
 * pnpm-workspace.yaml `packages:`. Null = no workspace config (single-package repo —
 * nested package.jsons are NOT local packages: without a workspace root there is no
 * node_modules link and tsc can't resolve them as bare specifiers).
 */
function rootWorkspaceGlobs(baseDir: string): string[] | null {
  const pj = join(baseDir, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { workspaces?: unknown };
    const w = pkg.workspaces;
    if (Array.isArray(w)) return w.filter((x): x is string => typeof x === 'string');
    if (w && typeof w === 'object' && !Array.isArray(w)) {
      const p = (w as Record<string, unknown>).packages;
      if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* no root package.json */
  }
  const yml = join(baseDir, 'pnpm-workspace.yaml');
  try {
    const lines = readFileSync(yml, 'utf8').split('\n');
    const idx = lines.findIndex((l) => /^packages\s*:/.test(l));
    if (idx !== -1) {
      const out: string[] = [];
      for (const l of lines.slice(idx + 1)) {
        if (!/^\s*-\s+/.test(l)) break;
        out.push(
          l
            .trim()
            .replace(/^[-\s]+/, '')
            .replace(/#.*$/, '')
            .trim(),
        );
      }
      if (out.length > 0) return out;
    }
  } catch {
    /* no pnpm-workspace.yaml */
  }
  return null;
}

/** Workspace glob → dir match (exact-directory semantics — pnpm/npm globs don't recurse:
 *  'packages/*' matches packages/ui but not packages/ui/sub; bare 'examples' matches only
 *  the examples dir itself). `!`-prefixed patterns exclude. */
function isWorkspaceMember(dir: string, globs: string[]): boolean {
  const match = (pattern: string) => {
    // Escape glob metachars that are regex metachars (dots, parens, brackets…)
    // BEFORE the wildcard translation: 'packages/foo.bar' must not match 'fooXbar'.
    const escaped = pattern.replace(/[.+(){}[\]|\\]/g, '\\$&');
    const re = new RegExp(`^${escaped.split('**').join('.*').split('*').join('[^/]*')}$`);
    return re.test(dir);
  };
  const positives = globs.filter((g) => !g.startsWith('!'));
  const negatives = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  return positives.some(match) && !negatives.some(match);
}

/**
 * Workspace package map: package.json `name` → PkgInfo. Built from the ancestor chain of
 * every code file (a file's nearest package.json owns it) — so packages with no code in
 * code-dirs never enter the map, and the root repo package.json (dir '.') is never read.
 * Gated on the root workspace globs: only true workspace members are local packages — a
 * standalone example's package.json (turbo's examples/*) is not resolvable by tsc (no
 * node_modules link), so it must not resolve as a bare specifier.
 */
function workspacePackages(files: ReadonlySet<string>, baseDir: string, ctx: ResolveCtx, globs: string[] | null): Map<string, PkgInfo> {
  const map = new Map<string, PkgInfo>();
  const seen = new Set<string>();
  for (const f of files) {
    let dir = dirname(f);
    while (dir !== '.' && !seen.has(dir)) {
      seen.add(dir);
      if (globs && !isWorkspaceMember(dir, globs)) {
        dir = dirname(dir);
        continue; // not a workspace member — its package.json is not a local package
      }
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
            const entry = probeCandidates(join(dir, (dot ?? main ?? 'src/index.ts').replace(/^\.\//, '')), ctx);
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

// --- disk probing (memoized per extract) ---

/** The probe candidate list for a repo-relative target: extension variants (`.d.ts` before
 *  `.ts` — types-only exports resolve to declaration files), index files, `.js`→`.ts`, and
 *  `dist/` → `src/` (a package's dist entry maps to its source tree). Order = TS resolution
 *  semantics: TS extensions first, then plain JS-family variants (CJS `require('./x')` must
 *  land on x.js), directory indexes, then the NodeNext `.js`→`.ts` remap. First existing
 *  candidate wins. Pure. */
function candidatesFor(rel: string): string[] {
  const toPosix = rel.replace(/\\/g, '/'); // win32: join emits backslashes; string ops below need /
  const srcRel = toPosix.replace(/(^|\/)dist\//, '$1src/');
  return [
    toPosix,
    `${toPosix}.d.ts`,
    `${toPosix}.ts`,
    `${toPosix}.tsx`,
    `${toPosix}.js`,
    `${toPosix}.jsx`,
    `${toPosix}.mjs`,
    `${toPosix}.cjs`,
    `${toPosix}.json`,
    `${toPosix}/index.ts`,
    `${toPosix}/index.tsx`,
    `${toPosix}/index.js`,
    `${toPosix}/index.jsx`,
    `${toPosix}/index.mjs`,
    `${toPosix}/index.cjs`,
    toPosix.replace(/\.js$/, '.ts'), // NodeNext: './x.js' → x.ts source
    toPosix.replace(/\.js$/, '.d.ts'), // …or the declaration file
    toPosix.replace(/\.js$/, '.tsx'), // vite-style: './x.js' → x.tsx
    toPosix.replace(/\.jsx$/, '.tsx'),
    toPosix.replace(/\.mjs$/, '.ts'),
    toPosix.replace(/\.mjs$/, '.mts'), // NodeNext: .mjs ↔ .mts
    toPosix.replace(/\.cjs$/, '.ts'),
    toPosix.replace(/\.cjs$/, '.cts'), // NodeNext: .cjs ↔ .cts
    srcRel,
    `${srcRel}.d.ts`,
    `${srcRel}.ts`,
    `${srcRel}.tsx`,
    `${srcRel}.js`,
    `${srcRel}.jsx`,
    `${srcRel}/index.ts`,
    `${srcRel}/index.tsx`,
    `${srcRel}/index.js`,
    `${srcRel}/index.jsx`,
    `${srcRel}/index.mjs`,
    `${srcRel}/index.cjs`,
    srcRel.replace(/\.js$/, '.ts'),
    srcRel.replace(/\.js$/, '.d.ts'),
    srcRel.replace(/\.js$/, '.tsx'),
    srcRel.replace(/\.jsx$/, '.tsx'),
    srcRel.replace(/\.mjs$/, '.ts'),
    srcRel.replace(/\.mjs$/, '.mts'),
    srcRel.replace(/\.cjs$/, '.ts'),
    srcRel.replace(/\.cjs$/, '.cts'),
  ];
}

/** Does a repo-relative path exist as a FILE on disk? Memoized in the extract's scratch map
 *  (monorepos issue hundreds of bare-specifier lookups and re-stat the same paths). */
function existsOnDisk(ctx: ResolveCtx, rel: string): boolean {
  const key = `${ctx.baseDir ?? '.'}\u0000${rel}`;
  const hit = ctx.memo.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    ok = statSync(join(ctx.baseDir ?? '.', rel)).isFile();
  } catch {
    ok = false;
  }
  ctx.memo.set(key, ok);
  return ok;
}

/** First existing candidate for a repo-relative target, or null. */
function probeCandidates(rel: string, ctx: ResolveCtx): string | null {
  for (const c of candidatesFor(rel)) {
    if (existsOnDisk(ctx, c)) {
      // normalize: candidates can carry './' prefixes or '..' segments (dir imports) —
      // the returned path must match the census's exact-path shape or the edge silently
      // dies at the ctx.files.has() check in resolveEdges.
      return posix.normalize(c);
    }
  }
  return null;
}

// --- resolution ---

/** Resolve a bare specifier against the workspace map: exact name → entry; `name/rest` via
 *  exports subpath keys, wildcard keys, then entry-dir + rest probes. `matched` distinguishes
 *  a broken local subpath (flag) from a genuinely external package (silent). Pure. */
function resolvePackageSpec(spec: string, map: Map<string, PkgInfo>, ctx: ResolveCtx): { matched: boolean; toFile: string | null } {
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
      const t = probeCandidates(join(pkg.dir, exact.replace(/^\.\//, '')), ctx);
      if (t) return { matched: true, toFile: t };
    }
    // 2) wildcard exports key (e.g. exports["./*"] = "./src/*" or "./features/*")
    const wild = wildcardTarget(pkg.exports, rest);
    if (wild) {
      const t = probeCandidates(join(pkg.dir, wild.replace(/^\.\//, '')), ctx);
      if (t) return { matched: true, toFile: t };
    }
    // 3) heuristic: no exports field → Node semantics — `name/rest` resolves to
    //    <pkgdir>/rest (stress #16: @turbo/utils/src/get-turbo-configs →
    //    packages/turbo-utils/src/get-turbo-configs.ts; the old entry-dir probe
    //    looked in src/src/ and flagged a resolvable import as broken). With
    //    exports, subpaths live under the entry's dir (the ./subpath shape).
    const entryDir = pkg.entry ? pkg.entry.slice(0, pkg.entry.lastIndexOf('/')) : pkg.dir;
    const base = pkg.exports ? entryDir : pkg.dir;
    const t = probeCandidates(join(base, rest), ctx);
    if (t) return { matched: true, toFile: t };
    // Known package with an entry whose subpath is absent → broken local import (flag).
    // No entry at all (dist-only, no source) → can't judge — stay silent like an external.
    return { matched: pkg.entry !== null, toFile: null };
  }
  return { matched: false, toFile: null };
}

/** Resolve a relative specifier (`./x`, `../x`, '.', '..') against the importing file's dir —
 *  shared probe (ext/index/dist→src variants), then the dir's package.json `main` (Node
 *  semantics: `import './'` or a dir with a main field resolves to it). Returns the probed
 *  file or null. Pure. */
function resolveRelative(spec: string, sourcePath: string, ctx: ResolveCtx): string | null {
  const target = posix.normalize(posix.join(posix.dirname(sourcePath), spec)).replace(/\/$/, '');
  const hit = probeCandidates(target, ctx);
  if (hit) return hit;
  // Directory import with a package.json main (vite's dep-relative-to-main fixture).
  try {
    const pkg = JSON.parse(readFileSync(join(ctx.baseDir ?? '.', target, 'package.json'), 'utf8')) as { main?: unknown };
    if (typeof pkg.main === 'string') return probeCandidates(join(target, pkg.main.replace(/^\.\//, '')), ctx);
  } catch {
    /* no package.json or malformed — nothing more to try */
  }
  return null;
}

/** Resolve one specifier → a file + whether a miss must be flagged as broken-local.
 *  `local=false` = external package/builtin — silent skip. Pure over ctx + facts. */
export function resolveOne(spec: string, sourcePath: string, ctx: ResolveCtx, facts: TsFacts): { toFile: string | null; local: boolean } {
  // Vite/rollup query suffixes (`./x.css?url`, `./worker?worker&url`): the target file is
  // the pre-`?` path; the suffix is a load-mode directive. Strip for resolution only — the
  // edge/unresolved record keeps the specifier as written.
  const q = spec.indexOf('?');
  if (q !== -1) spec = spec.slice(0, q);
  if (spec.startsWith('.')) return { toFile: resolveRelative(spec, sourcePath, ctx), local: true };

  // tsconfig `paths` aliases — the FILE's OWN tsconfig chain (nearest config walking up;
  // a merged map would apply one project's aliases to unrelated files). Longest alias
  // prefix wins; a mapped-but-missing target is a broken local import (flag). Star-less
  // aliases match exactly (TS semantics). A degenerate catch-all like `@*` (prefix `@`,
  // matches EVERY @-specifier — some example configs carry one) that misses is NOT
  // evidence the import is local: '@icons-pack/x' is an external package whose '@*'
  // alias in an unrelated app's tsconfig can't make it broken — fall through to
  // workspace/external classification instead of flagging.
  const aliases = aliasesForFile(sourcePath, facts, ctx.baseDir ?? '.');
  if (aliases && aliases.size > 0) {
    for (const [alias, targets] of [...aliases].sort((a, b) => b[0].length - a[0].length)) {
      const star = alias.indexOf('*');
      const prefix = star === -1 ? alias : alias.slice(0, star);
      if (star === -1 ? spec !== alias : !spec.startsWith(prefix)) continue;
      const rest = spec.slice(prefix.length);
      for (const t of targets) {
        const rel = t.includes('*') ? t.replace('*', rest) : t;
        const hit = probeCandidates(rel, ctx);
        // normalize: the probe returns the raw rel — '..' segments must collapse
        // before the edge meets the census (a literal-path membership check)
        if (hit) return { toFile: posix.normalize(hit), local: true };
      }
      if (star === -1 || prefix.length >= 2) return { toFile: null, local: true }; // specific alias → broken local
      break; // catch-all alias missed — not local evidence; try workspace/external
    }
  }
  // Alias-style prefixes with no mapping look local — likely a broken import or a missing
  // tsconfig `paths` entry (@/ ~/ are the webpack/vite convention; #/ is Nuxt/Nitro's).
  if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('#/')) return { toFile: null, local: true };

  // Bare specifier: workspace package (edge/unresolved) or external/builtin (silent).
  const pkg = resolvePackageSpec(spec, facts.packages, ctx);
  return { toFile: pkg.toFile, local: pkg.matched };
}
