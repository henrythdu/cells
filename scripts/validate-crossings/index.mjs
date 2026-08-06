#!/usr/bin/env node
/**
 * validate-crossings — independent audit of cells' import resolution.
 *
 * For each language, an oracle that is NOT cells' tree-sitter code resolves
 * every import in the repo; we compare its file→file edges against the
 * product's own edges (`cells imports --json`).
 *
 *   oracle-only edge  = cells MISSED an import             (under-flag — the dangerous class)
 *   ours-only edge    = cells resolved something the       (over-flag — inspect)
 *                       oracle didn't
 *   spec cross-check  = cells said "unresolved" but the     (classification bug)
 *                       oracle resolved that specifier     (ts oracle only — SCIP has
 *                                                           no specifier strings)
 *
 * Oracles (per-language toolchains — the more-likely-correct implementation):
 *   ts    tsc --traceResolution   (the TypeScript compiler itself)
 *   rust  rust-analyzer scip      (semantic resolution, SCIP references)
 *   go    scip-go                 (semantic resolution, SCIP references)
 *
 * SCIP→edges extraction is shared: symbol→file map from role-1 (definition)
 * occurrences; every non-definition occurrence in file F whose symbol is
 * defined in the same module → edge F→thatFile. File-level sets de-dupe
 * statement-vs-reference granularity.
 *
 * Usage:
 *   node index.mjs <repo-dir> <ts|rust|go> [options]
 *     --tsc <path>    tsc binary (default: $TSC or cells' node_modules/.bin/tsc)
 *     --cells <path>  cells dist/cli.js (default: $CELLS or ../../dist/cli.js)
 *     --scip <path>   scip CLI (default: $SCIP or scip on PATH)
 *     --top <n>       max sample lines per class (default 20)
 *
 * Exit code: 1 when the oracle found imports cells missed (under-flag).
 * The report is informational — it never gates cells itself.
 */
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';

const [, , repoArg, langArg, ...rest] = process.argv;
const args = new Map();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
const get = (k, d) => args.get(k) ?? d;

if (!repoArg || !['ts', 'rust', 'go', 'java', 'cpp', 'python'].includes(langArg)) {
  console.error('usage: node index.mjs <repo-dir> <ts|rust|go|java|cpp|python> [--tsc PATH] [--cells PATH] [--scip PATH] [--top N]');
  process.exit(2);
}

const repo = resolve(repoArg);
const lang = langArg;
const top = Number(get('--top', '20'));
const rel = (p) => {
  // SCIP relative_path is repo-relative; path.relative() would resolve it against cwd.
  let s = p.replace(/^file:\/\//, '');
  if (s.startsWith('/')) s = relative(repo, s).split(sep).join('/');
  return posix.normalize(s.replace(/^\.\//, ''));
};
const inRepo = (p) => p.startsWith(repo + sep);

/** Resolve a tool: env var → PATH → $HOME/go/bin (this machine's go installs land there, and PATH may carry a literal ~). */
const findBin = (envName, fallbackName) => {
  const direct = process.env[envName] || fallbackName;
  const v = run(direct, ['--version'], repo);
  if (v.ok) return { bin: direct, version: v.stdout.trim().split('\n')[0] };
  const home = join(process.env.HOME ?? '', 'go', 'bin', fallbackName);
  return { bin: home, version: run(home, ['--version'], repo).stdout.trim().split('\n')[0] };
};

const here = dirname(import.meta.url.replace('file://', ''));
const cellsBin = resolve(get('--cells', process.env.CELLS ?? join(here, '..', '..', 'dist', 'cli.js')));
const scipBin = findBin('SCIP', 'scip').bin;
const tscBin = resolve(get('--tsc', process.env.TSC ?? join(here, '..', '..', 'node_modules', '.bin', 'tsc')));
const raBin = findBin('RUST_ANALYZER', 'rust-analyzer').bin;
const scipGoBin = findBin('SCIP_GO', 'scip-go').bin;
const javaBin = findBin('SCIP_JAVA', 'scip-java').bin;
const cppBin = findBin('SCIP_CLANG', 'scip-clang').bin;
const pyrightBin = findBin('PYRIGHT', 'pyright').bin;

/** ------------------------------------------------------------------ */
/** Oracle cache — oracles are minutes on big repos; reruns must skip.   */
/** Keyed on (repo fingerprint + tool versions), stored in ~/.cache.     */
/** ------------------------------------------------------------------ */
const CACHE_DIR = join(process.env.HOME ?? tmpdir(), '.cache', 'cells-validate');

/** Cheap repo-state fingerprint: git HEAD + source count + newest mtime. */
function fingerprint() {
  let max = 0;
  let n = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.cells' || e.name === '.git' || e.name === 'dist') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        n++;
        const st = statSync(p);
        if (st.mtimeMs > max) max = st.mtimeMs;
      }
    }
  };
  walk(repo);
  const g = run('git', ['rev-parse', 'HEAD'], repo);
  return `${g.ok ? g.stdout.trim() : 'no-git'}:${n}:${Math.round(max)}`;
}

/** cells-side fingerprint: the repo fingerprint + cells' own src/dist state —
 *  importer edits must invalidate the cells cache even when the version
 *  string is unchanged (dev loop: fix importer → re-audit). */
function cellsFingerprint() {
  let max = 0;
  for (const root of [join(here, '..', '..', 'src'), join(here, '..', '..', 'dist')]) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const st = statSync(p);
          if (st.mtimeMs > max) max = st.mtimeMs;
        }
      }
    };
    walk(root);
  }
  return `${fingerprint()}:cells:${Math.round(max)}`;
}

const cacheKey = (kind, fp) => {
  // v7: cache FORMAT. The oracle cache holds RAW artifacts (tsc traces / decoded SCIP) —
  // extraction-logic changes re-parse them with current code and never re-run the compilers.
  const h = createHash('sha1')
    .update(`${repo}\0${lang}\0${kind}\0v7\0${fp ?? fingerprint()}`)
    .digest('hex')
    .slice(0, 16);
  return join(CACHE_DIR, `${h}.json.gz`);
};

/** cells-edge cache (JSON, edge-based — cells logic is versioned by src/dist mtimes). */
function loadCellsCache(toolVersion) {
  if (get('--no-cache', '') === '--no-cache') return undefined;
  try {
    const c = JSON.parse(readFileSync(cacheKey('cells', cellsFingerprint()), 'utf8'));
    if (c.toolVersion === toolVersion) return c;
  } catch {
    /* cold cache */
  }
  return undefined;
}

function saveCellsCache(toolVersion, data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${cacheKey('cells', cellsFingerprint())}.tmp`;
    writeFileSync(tmp, JSON.stringify({ toolVersion, ...data }));
    renameSync(tmp, cacheKey('cells', cellsFingerprint()));
  } catch {
    /* cache is a convenience — never fail the audit on it */
  }
}

/** Oracle cache: RAW artifacts (gzipped). toolVersion keys content (compiler version
 *  affects the trace); extraction logic lives in this file and re-runs on every load. */
function loadRawCache(kind, toolVersion) {
  if (get('--no-cache', '') === '--no-cache') return undefined;
  try {
    const c = JSON.parse(gunzipSync(readFileSync(cacheKey(kind))).toString('utf8'));
    if (c.toolVersion === toolVersion) return c.payload;
  } catch {
    /* cold cache */
  }
  return undefined;
}

function saveRawCache(kind, toolVersion, payload) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${cacheKey(kind)}.tmp`;
    writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify({ toolVersion, payload }))));
    renameSync(tmp, cacheKey(kind));
  } catch {
    /* cache is a convenience — never fail the audit on it */
  }
}

/** All TS/JS source files in the repo (the fallback pass traces the ones project configs don't see). */
function allSourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.cells' || e.name === '.git' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allSourceFiles(p));
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) out.push(rel(p));
  }
  return out;
}

/** Run a command; return { ok, stdout, stderr }. */
function run(cmd, argsArr, cwd, env = {}) {
  const r = spawnSync(cmd, argsArr, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** ------------------------------------------------------------------ */
/** SCIP → file→file edges (shared by the rust/go/java/cpp/python oracles). */
/** Each indexer's symbol vocabulary decides which refs are IMPORTS:        */
/**   go:     package/module symbols (trailing '/') — a file can name a      */
/**           package only via an import statement; value refs are uses.    */
/**   python: module symbols (trailing '/__init__:') — pyright-scip emits    */
/**           EVERY symbol reference (e.g. `self.json.dumps` refs the        */
/**           DefaultJSONProvider class); imports are the only module-symbol */
/**           refs.                                                          */
/**   rust/cpp/java: all non-local refs (no distinguishing convention).      */
/** ------------------------------------------------------------------ */
function edgesFromIndex(index, symbolKeep) {
  const keepRef = symbolKeep ?? (() => true);
  // symbol → defining file (role 1 = definition). RA uses file-scoped `local N`
  // symbols (same name in every file) — they must never cross files. Go package
  // symbols are defined in EVERY file of the package — prefer the non-test def
  // (last-write-wins would land on *_test.go and mispoint every reference).
  const symbolFile = new Map();
  for (const doc of index.documents ?? []) {
    const p = rel(doc.relative_path);
    if (p.startsWith('..')) continue;
    for (const o of doc.occurrences ?? []) {
      if (o.symbol.startsWith('local ')) continue;
      if (o.symbol_roles === 1 || o.symbolRoles === 1) {
        const existing = symbolFile.get(o.symbol);
        if (existing === undefined || (existing.endsWith('_test.go') && !p.endsWith('_test.go'))) {
          symbolFile.set(o.symbol, p);
        }
      }
    }
  }

  const edges = new Set();
  for (const doc of index.documents ?? []) {
    const from = rel(doc.relative_path);
    if (from.startsWith('..')) continue;
    for (const o of doc.occurrences ?? []) {
      if (o.symbol.startsWith('local ')) continue;
      const role = o.symbol_roles ?? o.symbolRoles ?? 0;
      if (role === 1) continue; // definitions are not edges
      if (!keepRef(o.symbol)) continue; // only import-carrying refs for this indexer
      const to = symbolFile.get(o.symbol);
      if (to && to !== from) edges.add(`${from}\0${to}`);
    }
  }
  return edges;
}

/** ------------------------------------------------------------------ */
/** Java oracle — import statements × the compiler's definition map.      */
/** scip-java emits refs for EVERY symbol use; Java has no symbol-shape   */
/** convention separating imports from uses (same-package access,          */
/** inheritance chains, return-type refs all reference class symbols).    */
/** The verifiable oracle: the file's own `import` statements, resolved   */
/** through scip-java's symbol→file map (the same derivation cells makes  */
/** from the census — divergences here are real def-map bugs). Symbols    */
/** are path-style: `scip-java maven <artifact> <version> <path>…` where   */
/** <path> ends at the first descriptor char (# . ( ) — class/field/      */
/** method). Build output (target/) is skipped — src defs are the truth.  */
/** ------------------------------------------------------------------ */
function edgesFromJava(index) {
  // slashed FQN path → defining file (non-test, non-target preference).
  const symbolFile = new Map();
  const fqnOf = (sym) => {
    const m = sym.match(/^scip-java maven [^ ]+ [^ ]+ ([^#.()]+)/);
    return m ? m[1].replace(/\//g, '.') : null; // com/google/x → com.google.x
  };
  for (const doc of index.documents ?? []) {
    const p = rel(doc.relative_path);
    if (p.startsWith('..') || p.includes('/target/')) continue;
    for (const o of doc.occurrences ?? []) {
      if ((o.symbol_roles ?? o.symbolRoles ?? 0) !== 1) continue; // definitions only
      const fqn = fqnOf(o.symbol);
      if (!fqn) continue;
      const existing = symbolFile.get(fqn);
      if (existing === undefined || (existing.includes('_test.') && !p.includes('_test.'))) symbolFile.set(fqn, p);
    }
  }
  const edges = new Set();
  const fromFiles = new Set();
  for (const doc of index.documents ?? []) {
    const from = rel(doc.relative_path);
    if (from.startsWith('..') || from.includes('/target/')) continue;
    fromFiles.add(from);
    let src;
    try {
      src = readFileSync(join(repo, from), 'utf8');
    } catch {
      continue;
    }
    const imports = [...src.matchAll(/^\s*import\s+(?:static\s+)?([\w.$]+)\s*;/gm)].map((m) => m[1]);
    for (const imp of imports) {
      // exact FQN, then progressively shorter prefixes (inner-class imports address
      // the OUTER class file — same walk as cells' resolver).
      let f = imp;
      for (;;) {
        const to = symbolFile.get(f);
        if (to && to !== from) {
          edges.add(`${from}\0${to}`);
          break;
        }
        const i = f.lastIndexOf('.');
        if (i <= 0) break;
        f = f.slice(0, i);
      }
    }
  }
  return { edges, resolvedSpecs: undefined, fromFiles };
}

/** ------------------------------------------------------------------ */
/** Oracle runners — RAW phase (runs compilers, collects artifacts)      */
/** ------------------------------------------------------------------ */
/** tsconfigs: root + subprojects under packages/, apps/, examples/ (depth ≤ 6 —
 *  turborepo's examples nest apps/packages 4+ levels deep; the -p pass carries
 *  each project's path aliases, which the flat fallback can't know). */
function discoverTsconfigs() {
  const tsconfigs = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.cells' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.name === 'tsconfig.json' && (depth === 0 || /(^|\/)(packages|apps|examples)(\/|$)/.test(join(dir, e.name)))) {
        tsconfigs.push(join(dir, e.name));
      }
    }
  };
  walk(repo, 0);
  return tsconfigs;
}

/** RAW ts oracle: run every tsc pass, return the transcripts (no parsing). Cached as-is;
 *  edge extraction re-runs on every load, so extraction-logic changes never re-run tsc. */
function oracleTsRaw() {
  const tsconfigs = discoverTsconfigs();
  const fallbackFlags = ['--noEmit', '--traceResolution', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--skipLibCheck', '--allowJs'];
  const raw = { tsconfigs: [], fallback: null };
  if (tsconfigs.length === 0) {
    // Plain-JS repos (no tsconfig): one allowJs pass over every source file.
    const all = allSourceFiles(repo);
    if (all.length === 0) throw new Error(`no JS/TS source files found in ${repo}`);
    raw.fallback = { trace: run(tscBin, [...fallbackFlags, ...all.map((f) => join(repo, f))], repo).stdout };
    return raw;
  }
  // Files outside EVERY program (tests, unlisted dirs) get one flat allowJs pass so
  // every repo file's imports are covered. Each project's own files resolve through
  // its -p pass (with its path aliases) — no flat-mode contamination.
  const listedAll = new Set();
  for (const tc of tsconfigs) {
    const trace = run(tscBin, ['--noEmit', '--traceResolution', '-p', tc], repo).stdout; // tsc exits nonzero on type errors — the trace is still complete
    const listed = run(tscBin, ['--noEmit', '--listFiles', '-p', tc], repo) // noEmit: --listFiles alone EMITS .js next to sources
      .stdout.split('\n')
      .map((f) => f.trim())
      .filter(inRepo)
      .map(rel);
    for (const f of listed) listedAll.add(f);
    raw.tsconfigs.push({ tc, trace, listed });
  }
  const uncovered = allSourceFiles(repo).filter((f) => !listedAll.has(f));
  if (uncovered.length > 0) raw.fallback = { trace: run(tscBin, [...fallbackFlags, ...uncovered.map((f) => join(repo, f))], repo).stdout };
  return raw;
}

/** Replay: parse cached transcripts into edges — runs with CURRENT extraction logic. */
function oracleTsFromRaw(raw) {
  const edges = new Set();
  const resolvedSpecs = new Map(); // fromFile → Set<spec> (spec-level cross-check)
  for (const { trace } of raw.tsconfigs) traceEdges(trace, edges, resolvedSpecs);
  if (raw.fallback) traceEdges(raw.fallback.trace, edges, resolvedSpecs);
  return { edges, resolvedSpecs };
}

/** Oracle targets land on the package's BUILT types (dist/index.d.ts via node_modules
 *  exports) where cells resolves source — that divergence is a REPORTED over-flag
 *  (oracle-resolved-to-dist is dropped by the dist scope filter), NOT something to
 *  map away: we validate our derivation, we don't force agreement.
 */

/** Parse a --traceResolution transcript into file→file edges + resolved specifiers. */
function traceEdges(stdout, edges, resolvedSpecs) {
  let cur = null;
  for (const line of stdout.split('\n')) {
    let m = line.match(/^======== Resolving module '([^']+)' from '([^']+)'\. ========$/);
    if (m) {
      cur = { spec: m[1], from: m[2] };
      continue;
    }
    // NodeNext lines end with " with Package ID 'x@y'. ========" — anchor on the
    // opening quote only (a path can't contain one); the trailer varies by mode.
    m = line.match(/^======== Module name '[^']+' was successfully resolved to '([^']+)'/);
    if (m && cur && inRepo(m[1])) {
      const from = rel(cur.from);
      const to = rel(m[1]);
      if (!from.startsWith('..') && !to.startsWith('..') && to !== from) {
        edges.add(`${from}\0${to}`);
        if (!resolvedSpecs.has(from)) resolvedSpecs.set(from, new Set());
        resolvedSpecs.get(from).add(cur.spec);
      }
    }
  }
}

/** RAW scip oracle: run the indexer, return the DECODED index (cached as-is). */
function oracleScipRaw(probe, buildArgs) {
  const tmp = mkdtempSync(join(tmpdir(), 'vc-scip-'));
  const scipFile = join(tmp, 'index.scip');
  const r = run(probe, buildArgs(scipFile), repo);
  if (!r.ok) {
    const err = r.stderr.slice(0, 600) || r.stdout.slice(0, 600);
    throw new Error(`${probe} failed: ${err}`);
  }
  return decodeScipIndex(scipFile);
}

const oracleRust = () => oracleScipRaw(raBin, (scipFile) => ['scip', '--output', scipFile, '.']); // RA needs the positional project path
const oracleGo = () => oracleScipRaw(scipGoBin, (scipFile) => ['index', '--output', scipFile, './...']); // scip-go indexes ONE package by default — ./... covers the module

/** RAW java oracle: scip-java runs mvn/gradle internally and writes repo/index.scip.
 *  --java-args appends extra build-tool args (e.g. "-Pandroid" for guava's android
 *  module, which the default maven reactor skips — the oracle's blind zone). */
function oracleJavaRaw() {
  const extra = (get('--java-args', '') ?? '').trim().split(/\s+/).filter(Boolean);
  const args = extra.length > 0 ? ['index', '--', '--batch-mode', 'clean', 'verify', '-DskipTests', ...extra] : ['index'];
  const r = run(javaBin, args, repo);
  if (!r.ok) throw new Error(`scip-java failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  const idx = join(repo, 'index.scip');
  const index = decodeScipIndex(idx);
  rmSync(idx, { force: true }); // scip-java writes into the repo — don't leave artifacts (mtime fingerprint)
  return index;
}

/** RAW cpp oracle: out-of-tree cmake config for compile_commands.json (repo stays pristine),
 *  then scip-clang with its own bundled clang. */
function oracleCppRaw() {
  if (!existsSync(join(repo, 'CMakeLists.txt'))) throw new Error(`no CMakeLists.txt in ${repo} — compile_commands.json needs a cmake configure`);
  const tmp = mkdtempSync(join(tmpdir(), 'vc-cpp-'));
  const build = join(tmp, 'build');
  const cfg = run('cmake', ['-B', build, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', repo], repo);
  if (!cfg.ok) throw new Error(`cmake configure failed: ${(cfg.stderr || cfg.stdout).slice(0, 600)}`);
  const idx = join(tmp, 'index.scip');
  const r = run(cppBin, ['--compdb-path', join(build, 'compile_commands.json'), '--index-output-path', idx], repo);
  if (!r.ok) throw new Error(`scip-clang failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return decodeScipIndex(idx);
}

/** RAW python oracle: pyright --dependencies --verbose prints the TRUE import graph
 *  (per file: " Imports N files" + file:// URIs, only with --verbose). scip-python was
 *  tried first — it emits every symbol reference (usage refs like `self.json.dumps`),
 *  and its import refs carry shortened module symbols that can't be matched to defs
 *  in src-layouts. pyright's deps output IS the import graph. Cached as raw text. */
function oraclePythonRaw() {
  let dirs = ['src', 'test'];
  try {
    const cfg = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    const m = cfg.match(/^code-dirs\s*=\s*\[([^\]]*)\]/m);
    if (m) {
      const parsed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      if (parsed.length > 0) dirs = parsed;
    }
  } catch {
    /* default code-dirs */
  }
  const r = run(pyrightBin, ['--verbose', '--dependencies', ...dirs], repo);
  // pyright exits nonzero when it finds type errors — the deps output is still complete.
  if (!r.stdout.includes(' Imports ')) throw new Error(`pyright --dependencies failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return r.stdout;
}

/** Parse pyright --dependencies --verbose output into file→file edges. Sections:
 *  <relpath> / " Imports N files" (file:// URIs, verbose) / " Imported by N files"
 *  (file:// URIs — the REVERSE graph, must not be collected). Noise lines
 *  (config, "Found N source files", diagnostics) match none of the patterns. */
function oraclePythonFromRaw(stdout) {
  const edges = new Set();
  const fromFiles = new Set();
  let cur = null;
  let inImports = false;
  for (const line of stdout.split('\n')) {
    if (/^ Imports\s+\d+ file/.test(line)) {
      inImports = true;
      continue;
    }
    if (/^ Imported by/.test(line)) {
      inImports = false; // reverse-graph section — stop collecting
      continue;
    }
    if (/^\S.*\.pyi?$/.test(line) && !line.startsWith('file://')) {
      const h = rel(line); // headers are repo-relative when pyright gets a config, absolute with positional dirs
      if (h.startsWith('..')) {
        cur = null; // outside the repo (e.g. the pip-installed copy in site-packages)
        inImports = false;
        continue;
      }
      cur = h; // section header
      fromFiles.add(h);
      inImports = false;
      continue;
    }
    if (cur && inImports && /^ {4}file:\/\//.test(line)) {
      const to = rel(line.trim().slice('file://'.length));
      if (!to.startsWith('..') && to !== cur) edges.add(`${cur}\0${to}`);
    }
  }
  return { edges, resolvedSpecs: undefined, fromFiles };
}

/** Run the scip CLI to decode an index file into JSON (the shared RAW artifact). */
function decodeScipIndex(file) {
  const dec = run(scipBin, ['print', '--json', file], repo);
  if (!dec.ok) throw new Error(`scip print failed: ${dec.stderr.slice(0, 400)}`);
  try {
    return JSON.parse(dec.stdout);
  } catch {
    throw new Error(`scip print produced no JSON (index corrupt or empty): ${dec.stdout.slice(0, 200)}`);
  }
}

/** ------------------------------------------------------------------ */
/** cells side                                                          */
/** ------------------------------------------------------------------ */
function cellsEdges() {
  const r = run(process.execPath, [cellsBin, 'imports', '--json'], repo);
  if (!r.ok) throw new Error(`cells imports --json failed: ${r.stderr.slice(0, 600)}`);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new Error(`cells imports --json produced no JSON: ${r.stdout.slice(0, 200)}`);
  }
  const edges = new Set(data.edges.map((e) => `${e.fromFile}\0${e.toFile}`));
  const unresolved = new Map(data.unresolved.map((u) => [`${u.fromFile}\0${u.import}`, u]));
  return { edges, unresolved };
}

/** ------------------------------------------------------------------ */
/** Report                                                              */
/** ------------------------------------------------------------------ */
function sampleLines(set, n, fmt) {
  const all = [...set].sort();
  const shown = all.slice(0, n);
  const out = shown.map((k) => `  ${fmt(k)}`);
  if (all.length > n) out.push(`  …and ${all.length - n} more`);
  return out;
}

function main() {
  const oracleTool =
    lang === 'ts'
      ? { name: 'tsc', version: run(tscBin, ['--version'], repo).stdout.trim() }
      : lang === 'rust'
        ? { name: 'rust-analyzer', version: run(raBin, ['--version'], repo).stdout.trim() }
        : lang === 'go'
          ? { name: 'scip-go', version: run(scipGoBin, ['--version'], repo).stdout.trim() }
          : lang === 'java'
            ? { name: 'scip-java', version: `${run(javaBin, ['--version'], repo).stdout.trim()} ${(get('--java-args', '') ?? '').trim()}` }
            : lang === 'cpp'
              ? { name: 'scip-clang', version: run(cppBin, ['--version'], repo).stdout.trim() }
              : { name: 'pyright', version: run(pyrightBin, ['--version'], repo).stdout.trim() };
  const oracleVersion = `${oracleTool.name} ${oracleTool.version}`;
  const oracle =
    loadRawCache('oracle', oracleVersion) ??
    (() => {
      const raw =
        lang === 'ts'
          ? oracleTsRaw()
          : lang === 'rust'
            ? oracleRust()
            : lang === 'go'
              ? oracleGo()
              : lang === 'java'
                ? oracleJavaRaw()
                : lang === 'cpp'
                  ? oracleCppRaw()
                  : oraclePythonRaw();
      saveRawCache('oracle', oracleVersion, raw);
      return raw;
    })();
  // RAW artifacts are cached; extraction re-runs with CURRENT logic every load.
  const symbolKeep = lang === 'go' ? (s) => s.endsWith('/') : undefined;
  const oracleParsed =
    lang === 'ts'
      ? oracleTsFromRaw(oracle)
      : lang === 'python'
        ? oraclePythonFromRaw(oracle)
        : lang === 'java'
          ? edgesFromJava(oracle)
          : { edges: edgesFromIndex(oracle, symbolKeep), resolvedSpecs: undefined };

  let cellsVersion = 'cells ?';
  try {
    cellsVersion = `cells ${JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version}`;
  } catch {
    /* version read is a cache-key nicety — fall back to a fixed key */
  }
  const ours =
    loadCellsCache(cellsVersion) ??
    (() => {
      const o = cellsEdges();
      saveCellsCache(cellsVersion, { edges: [...o.edges], unresolved: [...o.unresolved] });
      return o;
    })();
  if (ours.unresolved) ours.unresolved = new Map(ours.unresolved); // cache round-trip

  // Files the oracle never indexed (alternate-source trees like GWT's src-super,
  // SDK-gated modules like guava's android/failureaccess) are oracle BLIND ZONES —
  // cells' edges touching them can't be verified. Drop both sides' edges that touch
  // blind files and report the count: honest, and it replaces per-repo hardcoding.
  const oracleFromFiles = oracleParsed.fromFiles;
  const blindFiles = oracleFromFiles
    ? [...new Set([...ours.edges].flatMap((k) => k.split('\0')))].filter((f) => !oracleFromFiles.has(f))
    : [];
  const notBlind = (k) => {
    const [f, t] = k.split('\0');
    return !blindFiles.includes(f) && !blindFiles.includes(t);
  };

  // Go imports are package-level, but both sides pin them to a representative file —
  // and they pick DIFFERENT representatives. Compare Go at package granularity
  // (dirname of the target); the representative-file choice becomes irrelevant.
  // Java: the mirror image — same-package classes need NO import statement, so
  // scip-java's usage refs inside a package are not import edges; cross-package
  // refs are impossible without an import. Drop same-dir oracle edges.
  const normalize = (set) => {
    if (lang === 'go') {
      const out = new Set();
      for (const k of set) {
        const [f, t] = k.split('\0');
        const tdir = posix.dirname(t);
        if (tdir !== posix.dirname(f)) out.add(`${f}\0${tdir}`); // same-dir = same package = not an import
      }
      return out;
    }
    if (lang === 'java') {
      const out = new Set();
      for (const k of set) {
        const [f, t] = k.split('\0');
        if (posix.dirname(f) !== posix.dirname(t)) out.add(k); // same-package use needs no import
      }
      return out;
    }
    return set;
  };
  // Scope the comparison to the audited language: our side keeps only edges
  // FROM ts/js files; the oracle side drops node_modules (type-dep internals the
  // census never sees) and non-code targets (json/package.json — cells reports
  // those as unresolved, the compiler resolves them as data imports).
  const tsExt = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  const langExt = {
    ts: tsExt,
    java: /\.(java|kt)$/,
    cpp: /\.(c|h|cc|cpp|cxx|hpp|hxx|hh|m|mm)$/,
    python: /\.py$/,
  }[lang];
  const scoped = (set, side) => {
    const out = new Set();
    for (const k of set) {
      const [f, t] = k.split('\0');
      if (f.startsWith('node_modules/') || t.startsWith('node_modules/')) continue;
      if (f.includes('/dist/') || t.includes('/dist/')) continue; // built output — the census skips dist
      if (f.includes('/target/') || t.includes('/target/')) continue; // maven build output (guava's GWT source copies)
      if (lang === 'ts') {
        if (side === 'oracle' && !tsExt.test(t)) continue;
        if (side === 'ours' && !tsExt.test(f)) continue;
      }
      if (langExt && side === 'ours' && !langExt.test(f)) continue; // our side keeps only edges FROM the audited language
      // scip-clang emits header→source definition-use edges (symbol def in the header, use in
      // the .cpp). Headers aren't importers in the cells model (only #include sources are) —
      // the reverse direction (source→header) is the real import and stays.
      if (lang === 'cpp' && side === 'oracle' && /\.(h|hpp|hxx|hh)$/.test(f)) continue;
      out.add(k);
    }
    return out;
  };
  const oracleEdges = new Set([...scoped(normalize(oracleParsed.edges), 'oracle')].filter(notBlind));
  const ourEdges = new Set([...scoped(normalize(ours.edges), 'ours')].filter(notBlind));

  const oracleOnly = [...oracleEdges].filter((k) => !ourEdges.has(k));
  const oursOnly = [...ourEdges].filter((k) => !oracleEdges.has(k));

  // classification cross-check (ts only): a specifier cells left unresolved
  // that the compiler itself resolved
  const falseUnresolved = [];
  if (oracleParsed.resolvedSpecs) {
    for (const [, u] of ours.unresolved) {
      const from = u.fromFile;
      const specs = oracleParsed.resolvedSpecs.get(from);
      if (specs?.has(u.import)) falseUnresolved.push(`${from} imports "${u.import}"`);
    }
  }

  const lines = [];
  lines.push(`# crossing validation — ${lang} on ${repo}`);
  lines.push(`  our edges: ${ourEdges.size}   oracle edges: ${oracleEdges.size}${lang === 'go' ? '  (package-granular: target = package dir)' : ''}`);
  if (blindFiles.length > 0) lines.push(`  ${blindFiles.length} file(s) oracle-blind (not indexed by the oracle — e.g. alternate-source trees, SDK-gated modules) — their edges unverifiable, dropped from both sides`);
  lines.push('');
  lines.push(`## under-flag (oracle resolved, cells missed): ${oracleOnly.length}`);
  if (oracleOnly.length > 0) lines.push(...sampleLines(oracleOnly, top, (k) => k.replace('\0', ' → ')));
  lines.push('');
  lines.push(`## over-flag (cells resolved, oracle did not): ${oursOnly.length}`);
  if (oursOnly.length > 0) lines.push(...sampleLines(oursOnly, top, (k) => k.replace('\0', ' → ')));
  lines.push('');
  if (falseUnresolved.length > 0) {
    lines.push(`## false unresolved (compiler resolved what cells flagged): ${falseUnresolved.length}`);
    lines.push(...sampleLines(falseUnresolved, top, (k) => k));
    lines.push('');
  }
  const verdict = oracleOnly.length === 0 ? '✓ parity — no imports missed' : `✗ ${oracleOnly.length} import(s) missed — inspect (tree-sitter gap or edge case)`;
  lines.push(verdict);

  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = oracleOnly.length > 0 ? 1 : 0;
}

main();
