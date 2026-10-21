import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { ResolveCtx } from './tree-sitter.js';

/**
 * The resolution of TypeScript, JS, and TSX specifiers. This is the deep core that the three
 * importer specs of the TS family share (typescript, tsx, and javascript). The input is a
 * specifier and the importing file. The output is the resolution decision: `toFile`, which is
 * repository-relative, or a classification of the miss. A miss with `local` set is a broken
 * local import to flag, and a miss with `false` is external or a builtin to skip silently.
 *
 * The resolution semantics come from the dep-cruiser importer and keep the same behavior:
 *  - A relative specifier (`./x`, `..`) probes the candidates for an extension, an index
 *    file, and the `dist` to `src` mapping. The code draws an edge when the target is a
 *    census file. An existing non-code target (css, json) is real but silent. Nothing on
 *    disk is unresolved, which is the honest result.
 *  - An `@/`, `~/`, or `#/` prefix, and any `paths` alias of tsconfig, resolves through the
 *    merged tsconfig map of the repository, which tolerates jsonc. A mapped target that is
 *    missing is unresolved.
 *  - A bare specifier resolves through the workspace package map: the name in `package.json`
 *    becomes a directory, then the exact and wildcard subpaths of `exports`, then the package
 *    directory plus the rest of the path, in the Node style. A known package with a broken
 *    subpath is unresolved. An unknown name (an external dependency or a Node builtin) is
 *    silent.
 *
 * The importer works from the source only: it reads `package.json` and `tsconfig.json` and
 * never executes them. The resolution facts (the package map and the alias map) build one
 * time per extract, with a `WeakMap` keyed on the `ctx` of the factory.
 */

/** A workspace package: its directory (repository-relative), its parsed `exports` field (for
 *  the subpath keys), and the resolved source file of its `.` entry, or null. */
interface PkgInfo {
  dir: string;
  exports: Record<string, unknown> | null;
  entry: string | null;
}

/** The resolution facts of one extract: the workspace package map and the tsconfig alias maps
 *  per directory, with the extends chain resolved. Both are pure over the census files and
 *  `baseDir` and are expensive to build, so the code computes them one time per extract. The
 *  key is the `ResolveCtx` of the factory, which is an object per extract: the garbage
 *  collector can free it, and no value goes stale across runs. */
export interface TsFacts {
  packages: Map<string, PkgInfo>;
  /** The config file path to the alias map with the chain resolved (targets relative to the root). Null means that no config exists there. */
  configs: Map<string, Map<string, string[]> | null>;
  /** A map from file to the aliases of its nearest config. Null means that no config exists on the ancestor chain. */
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

// --- Parsing tsconfig (jsonc) ---

/** Strip JSONC down to strict JSON: the slash-slash comments, the slash-star comments, and
 *  the trailing commas.
 *  The function is careful with strings, so a URL such as `https://x` or a `//` inside a
 *  string survives. The `typescript` package used to do this work through `readConfigFile`,
 *  and a stripper of about 20 lines replaces the 60 MB dependency. */
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

/** Parse a `tsconfig.json` file. JSONC permits comments and trailing commas. The function
 *  returns null on a failure. It is the equivalent of `readConfigFile` from typescript,
 *  written as a jsonc strip plus `JSON.parse`. */
function readTsconfig(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stripJsonc(readFileSync(filePath, 'utf8'))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The `paths` of one tsconfig with the extends chain resolved: the keys of the config itself
 * plus the keys of its `extends` chain. A child overrides an alias per key, and a parent
 * alias persists, which is the shallow merge of tsc. The function rewrites the targets to be
 * relative to the repository root, because the targets of each config are relative to its own
 * directory or `baseUrl`. A package-name extends (`@tsconfig/...`) is skipped, because the
 * importer works from the source only and reads no `node_modules`, and such a config rarely
 * carries the paths that matter.
 *
 * The key is the FILE path of the config. An extends can name any file: a
 * `tsconfig.base.json` in the same directory, or a `../../tsconfig.json` at the repository
 * root. A probe keyed by directory would re-read THIS config on a same-directory extends,
 * which recursed without end and killed the importer on every repository with a base config
 * (a RangeError). The visiting guard, which sets the cache entry before the recursion,
 * also terminates a cycle across files. The result is memoized per file. The function is pure.
 */
function configAliases(configPath: string, baseDir: string, cache: Map<string, Map<string, string[]> | null>): Map<string, string[]> | null {
  const hit = cache.get(configPath);
  if (hit !== undefined) return hit;
  cache.set(configPath, null); // The visiting guard. A cycle reads the placeholder and does not recurse again.
  let merged: Map<string, string[]> | null = null;
  if (existsSync(join(baseDir, configPath))) {
    const cfg = readTsconfig(join(baseDir, configPath)) as { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | null;
    if (cfg) {
      // An EXISTING config that parses is TERMINAL for the ancestor walk of `aliasesForFile`,
      // so the function returns a map, at least an empty one, and never null. Null used to
      // mean both "no config here" and "a config without paths", so the walk continued PAST a
      // nested project without paths and applied the aliases of the ROOT to its files. That
      // cross-project contamination is exactly what the owning-program model forbids.
      merged = new Map();
      if (typeof cfg.extends === 'string' && !cfg.extends.startsWith('@')) {
        const ext = posix.normalize(posix.join(posix.dirname(configPath), cfg.extends));
        const parent = configAliases(ext, baseDir, cache);
        if (parent) merged = new Map(parent);
      }
      const paths = cfg.compilerOptions?.paths;
      if (paths) {
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

/** Return the aliases of a file: the nearest tsconfig on its ancestor chain. This is the
 *  owning-program model of tsc, where the config of a nested project shadows the root
 *  config. A merged map would cross-contaminate independent projects, for example when the
 *  `@/` aliases of one fixture apply to the files of another. */
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

// --- The workspace package map ---

/** Return the first string in an object of conditional exports, and recurse into the nested
 *  conditionals, in the priority order types, import, module, and default. The function is
 *  pure. */
function firstString(obj: Record<string, unknown>): string | undefined {
  for (const k of ['types', 'import', 'module', 'default']) {
    const v = obj[k];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && !Array.isArray(v)) return firstString(v as Record<string, unknown>);
  }
  return undefined;
}

/** Return the value of an exports field as a string: the value itself when it is a string, or
 *  the first string of a conditional object. Otherwise undefined. The function is pure. */
function targetString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) return firstString(v as Record<string, unknown>);
  return undefined;
}

/** Return the target of an `exports` subpath of a `package.json` as a source file, or null. The function is pure. */
function exportsTarget(exports: Record<string, unknown> | null, key: string): string | null {
  if (!exports) return null;
  return targetString(exports[key]) ?? null;
}

/** Match an exports wildcard key against the subpath and return the target, or null. For
 *  example `./features/*` matches `features/x`, and `./*` matches anything. The function
 *  substitutes the subpath for the `*`. It is pure. */
function wildcardTarget(exports: Record<string, unknown> | null, rest: string): string | null {
  if (!exports) return null;
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star); // For example './features/'. The keys carry the leading './'.
    if (prefix.length < 2 || !rest.startsWith(prefix.slice(2))) continue;
    const target = targetString(value);
    if (!target || !target.includes('*')) continue;
    return target.replace('*', rest.slice(prefix.length - 2));
  }
  return null;
}

/**
 * Return the globs of the root workspace: the `workspaces` field of `package.json` (an npm
 * array or a yarn object with `packages`), or the `packages` list in `pnpm-workspace.yaml`.
 * A null result means that there is no workspace config, so the repository has one package.
 * A nested `package.json` is then NOT a local package: without a workspace root there is no
 * `node_modules` link, and tsc cannot resolve the package as a bare specifier.
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
    /* There is no root package.json. */
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
            .trim()
            .replace(/^['"]|['"]$/g, ''), // The YAML strings arrive quoted (`- 'packages/*'`). A quoted glob matched nothing and silently emptied the map.
        );
      }
      if (out.length > 0) return out;
    }
  } catch {
    /* There is no pnpm-workspace.yaml. */
  }
  return null;
}

/** Say whether a directory matches a workspace glob. The match has exact-directory semantics,
 *  because the globs of pnpm and npm do not recurse: `packages/*` matches `packages/ui` and
 *  not `packages/ui/sub`, and a bare `examples` matches only the directory `examples`. A
 *  pattern with a `!` prefix excludes. */
function isWorkspaceMember(dir: string, globs: string[]): boolean {
  const match = (pattern: string) => {
    // Escape the glob metacharacters that are also regex metacharacters (dots, parentheses,
    // brackets, and others) BEFORE the translation of the wildcards, so that
    // `packages/foo.bar` does not match `fooXbar`.
    const escaped = pattern.replace(/[.+(){}[\]|\\]/g, '\\$&');
    // Translate in one pass: `**` becomes `.*`, which matches any depth including `/`, and a
    // lone `*` becomes `[^/]*`. A chained split and join rewrites the inserted `.*` again
    // (`.` plus `*` becomes `.[^/]*`), so `packages/**` matched one level only and a nested
    // member directory silently left the map.
    const re = new RegExp(`^${escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'))}$`);
    return re.test(dir);
  };
  const positives = globs.filter((g) => !g.startsWith('!'));
  const negatives = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  return positives.some(match) && !negatives.some(match);
}

/**
 * Build the workspace package map, from the `name` in `package.json` to a `PkgInfo`. The
 * function builds it from the ancestor chain of every code file, so the nearest
 * `package.json` owns the file. A package with no code in the code directories therefore
 * never enters the map, and the `package.json` of the root repository (the directory `.`) is
 * never read. The build is gated on the globs of the root workspace, so only a true workspace
 * member is a local package. The `package.json` of a standalone example (such as the
 * `examples/*` of turbo) is not resolvable by tsc, because there is no `node_modules` link,
 * so it must not resolve as a bare specifier.
 */
function workspacePackages(files: ReadonlySet<string>, baseDir: string, ctx: ResolveCtx, globs: string[] | null): Map<string, PkgInfo> {
  const map = new Map<string, PkgInfo>();
  const seen = new Set<string>();
  for (const f of files) {
    let dir = dirname(f);
    while (dir !== '.' && !seen.has(dir)) {
      seen.add(dir);
      // No workspace config (the globs are null) means a repository with one package. A nested
      // `package.json` has no `node_modules` link, so it is NOT a local package. The previous
      // short-circuit (`globs && ...`) let it through and created a false edge to a directory
      // that tsc can never resolve.
      if (!globs || !isWorkspaceMember(dir, globs)) {
        dir = dirname(dir);
        continue;
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
          /* The package.json is malformed, so skip it. The imports of the package stay external. */
        }
        break; // The nearest package owns the file, so do not walk past it.
      }
      dir = dirname(dir);
    }
  }
  return map;
}

// --- Probing the disk, memoized per extract ---

/** The probe suffixes. First the plain appends (the TypeScript extensions, then the JS family,
 *  then the directory indexes), then the remaps of extensions (NodeNext maps `.js` to `.ts`,
 *  vite maps `.jsx` to `.tsx`, and so on). The order follows the resolution semantics of
 *  TypeScript, and the first existing candidate wins. */
const APPEND_SUFFIXES = ['.d.ts', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs'];
/** The bare probes for `.mjs`, `.cjs`, and `.json` run on the base path as written, and the
 *  code keeps this list exactly: the first match wins, so do not merge the list into
 *  `APPEND_SUFFIXES` and do not reorder it. */
const POSIX_ONLY_SUFFIXES = ['.mjs', '.cjs', '.json'];
const REMAP_SUFFIXES: [RegExp, string][] = [
  [/\.js$/, '.ts'], // NodeNext: './x.js' becomes x.ts in the source
  [/\.js$/, '.d.ts'], // ...or the declaration file
  [/\.js$/, '.tsx'], // The vite style: './x.js' becomes x.tsx
  [/\.jsx$/, '.tsx'],
  [/\.mjs$/, '.ts'],
  [/\.mjs$/, '.mts'], // NodeNext: .mjs and .mts are a pair
  [/\.cjs$/, '.ts'],
  [/\.cjs$/, '.cts'], // NodeNext: .cjs and .cts are a pair
];

/** Expand one base path into its probe list: the base as written, then the base with `dist/` changed to `src/`. */
function expandProbes(base: string, extraPlain: string[]): string[] {
  return [base, ...APPEND_SUFFIXES.slice(0, 5), ...extraPlain, ...APPEND_SUFFIXES.slice(5)].map((s) => `${base}${s}`).concat(REMAP_SUFFIXES.map(([re, rep]) => base.replace(re, rep)));
}
/** Return the probe candidates for a repository-relative target: the base as written, then
 *  the `dist/` to `src/` form of the base, because the dist entry of a package maps to its
 *  source tree. `.d.ts` comes before `.ts`, so a types-only export resolves to a declaration
 *  file. The first existing candidate wins. The function is pure. */
function candidatesFor(rel: string): string[] {
  const toPosix = rel.replace(/\\/g, '/'); // win32: join emits backslashes, and the string operations below need /.
  const srcRel = toPosix.replace(/(^|\/)dist\//, '$1src/');
  return [...expandProbes(toPosix, POSIX_ONLY_SUFFIXES), ...expandProbes(srcRel, [])];
}

/** Say whether a repository-relative path exists as a FILE on disk. The result is memoized in
 *  the scratch map of the extract, because a monorepo issues hundreds of lookups for a bare
 *  specifier and stats the same paths again. */
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

/** Return the first existing candidate for a repository-relative target, or null. */
function probeCandidates(rel: string, ctx: ResolveCtx): string | null {
  for (const c of candidatesFor(rel)) {
    if (existsOnDisk(ctx, c)) {
      // Normalize. A candidate can carry a './' prefix or '..' segments (a directory import),
      // and the returned path must match the exact-path shape of the census, or the edge
      // silently dies at the `ctx.files.has()` check in `resolveEdges`.
      return posix.normalize(c);
    }
  }
  return null;
}

// --- Resolution ---

/** Resolve a bare specifier against the workspace map. An exact name gives the entry. A
 *  `name/rest` form goes through the `exports` subpath keys, then the wildcard keys, then the
 *  probes of the entry directory plus the rest. The `matched` flag separates a broken local
 *  subpath, which is a flag, from a genuinely external package, which is silent. The function
 *  is pure. */
function resolvePackageSpec(spec: string, map: Map<string, PkgInfo>, ctx: ResolveCtx): { matched: boolean; toFile: string | null } {
  const parts = spec.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const name = parts.slice(0, i).join('/');
    const pkg = map.get(name);
    if (!pkg) continue;
    const rest = parts.slice(i).join('/');
    if (!rest) return { matched: true, toFile: pkg.entry };
    // 1) The exact exports subpath key (for example `exports["./with-module"]`).
    const exact = exportsTarget(pkg.exports, `./${rest}`);
    if (exact) {
      const t = probeCandidates(join(pkg.dir, exact.replace(/^\.\//, '')), ctx);
      if (t) return { matched: true, toFile: t };
    }
    // 2) The wildcard exports key (for example `exports["./*"] = "./src/*"` or `"./features/*"`).
    const wild = wildcardTarget(pkg.exports, rest);
    if (wild) {
      const t = probeCandidates(join(pkg.dir, wild.replace(/^\.\//, '')), ctx);
      if (t) return { matched: true, toFile: t };
    }
    // 3) The heuristic for no exports field: the Node semantics make `name/rest` resolve to
    //    <pkgdir>/rest. `@turbo/utils/src/get-turbo-configs` becomes
    //    `packages/turbo-utils/src/get-turbo-configs.ts`. A probe relative to the entry
    //    directory would look in `src/src/` and flag a resolvable import as broken. With an
    //    exports field, a subpath lives under the directory of the entry (the `./subpath`
    //    shape).
    const entryDir = pkg.entry ? pkg.entry.slice(0, pkg.entry.lastIndexOf('/')) : pkg.dir;
    const base = pkg.exports ? entryDir : pkg.dir;
    const t = probeCandidates(join(base, rest), ctx);
    if (t) return { matched: true, toFile: t };
    // A known package with an entry whose subpath is absent is a broken local import, so flag
    // it. A package with no entry at all (dist only, no source) cannot be judged, so stay
    // silent like an external.
    return { matched: pkg.entry !== null, toFile: null };
  }
  return { matched: false, toFile: null };
}

/** Resolve a relative specifier (`./x`, `../x`, `.`, `..`) against the directory of the
 *  importing file. The function uses the shared probe, which covers the extension, index, and
 *  `dist` to `src` variants, and then the `main` field of the `package.json` of the directory.
 *  These are the Node semantics: `import './'` or a directory with a `main` field resolves to
 *  that file. The function returns the probed file or null. It is pure. */
function resolveRelative(spec: string, sourcePath: string, ctx: ResolveCtx): string | null {
  const target = posix.normalize(posix.join(posix.dirname(sourcePath), spec)).replace(/\/$/, '');
  const hit = probeCandidates(target, ctx);
  if (hit) return hit;
  // A directory import with a `main` field in `package.json` (the vite fixture dep-relative-to-main).
  try {
    const pkg = JSON.parse(readFileSync(join(ctx.baseDir ?? '.', target, 'package.json'), 'utf8')) as { main?: unknown };
    if (typeof pkg.main === 'string') return probeCandidates(join(target, pkg.main.replace(/^\.\//, '')), ctx);
  } catch {
    /* There is no package.json, or it is malformed. There is nothing more to try. */
  }
  return null;
}

/** Resolve one specifier to a file, and say whether a miss must be flagged as broken local.
 *  With `local` false, the specifier is an external package or a builtin and the function
 *  skips it silently. The function is pure over `ctx` and the facts. */
export function resolveOne(spec: string, sourcePath: string, ctx: ResolveCtx, facts: TsFacts): { toFile: string | null; local: boolean } {
  // The query suffixes of vite and rollup (`./x.css?url`, `./worker?worker&url`). The target
  // file is the path before the `?`, and the suffix is a directive of the load mode. The code
  // strips the suffix for the resolution only, and the edge and the unresolved record keep the
  // specifier as written.
  const q = spec.indexOf('?');
  if (q !== -1) spec = spec.slice(0, q);
  if (spec.startsWith('.')) return { toFile: resolveRelative(spec, sourcePath, ctx), local: true };

  // The `paths` aliases of tsconfig, through the tsconfig chain of the FILE itself: the
  // nearest config, walking up. A merged map would apply the aliases of one project to
  // unrelated files. The longest alias prefix wins, and a mapped target that is missing is a
  // broken local import, so flag it. An alias without a star matches exactly, which is the
  // TypeScript semantics. A degenerate catch-all such as `@*` (with the prefix `@`, it matches
  // EVERY specifier that starts with `@`, and some example configs carry one) that misses is
  // NOT evidence that the import is local: `@icons-pack/x` is an external package, and the
  // `@*` alias in the tsconfig of an unrelated app cannot make it broken. The code therefore
  // falls through to the workspace or external classification instead of flagging.
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
        // Normalize. The probe returns the raw relative path, and the '..' segments must
        // collapse before the edge meets the census, which is a literal check of membership.
        if (hit) return { toFile: posix.normalize(hit), local: true };
      }
      if (star === -1 || prefix.length >= 2) return { toFile: null, local: true }; // A specific alias means a broken local import.
      break; // The catch-all alias missed, which is not local evidence. Try the workspace or an external package.
    }
  }
  // An alias-style prefix with no mapping looks local, and it is probably a broken import or a
  // missing `paths` entry in tsconfig. `@/` and `~/` are the convention of webpack and vite,
  // and `#/` is the convention of Nuxt and Nitro.
  if (spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('#/')) return { toFile: null, local: true };

  // A bare specifier: a workspace package (an edge or an unresolved import), or an external package or builtin (silent).
  const pkg = resolvePackageSpec(spec, facts.packages, ctx);
  return { toFile: pkg.toFile, local: pkg.matched };
}
