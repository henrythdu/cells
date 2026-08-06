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
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep, posix } from 'node:path';

const [, , repoArg, langArg, ...rest] = process.argv;
const args = new Map();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
const get = (k, d) => args.get(k) ?? d;

if (!repoArg || !['ts', 'rust', 'go'].includes(langArg)) {
  console.error('usage: node index.mjs <repo-dir> <ts|rust|go> [--tsc PATH] [--cells PATH] [--scip PATH] [--top N]');
  process.exit(2);
}

const repo = resolve(repoArg);
const lang = langArg;
const top = Number(get('--top', '20'));
const rel = (p) => posix.normalize(relative(repo, p).split(sep).join('/'));
const inRepo = (p) => p.startsWith(repo + sep);

/** Resolve a tool: env var → PATH → $HOME/go/bin (this machine's go installs land there, and PATH may carry a literal ~). */
const findBin = (envName, fallbackName) => {
  const direct = process.env[envName] || fallbackName;
  if (run(direct, ['--version'], repo).ok) return direct;
  return join(process.env.HOME ?? '', 'go', 'bin', fallbackName);
};

const here = dirname(import.meta.url.replace('file://', ''));
const cellsBin = resolve(get('--cells', process.env.CELLS ?? join(here, '..', '..', 'dist', 'cli.js')));
const scipBin = findBin('SCIP', 'scip');
const tscBin = resolve(get('--tsc', process.env.TSC ?? join(here, '..', '..', 'node_modules', '.bin', 'tsc')));
const raBin = findBin('RUST_ANALYZER', 'rust-analyzer');
const scipGoBin = findBin('SCIP_GO', 'scip-go');

/** All TS/JS source files in the repo (the fallback pass traces the ones project configs don't see). */
function allSourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.cells' || e.name === '.git' || e.name === 'dist' || e.name.startsWith('.')) continue;
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
/** SCIP → file→file edges (shared by the rust + go oracles).           */
/** ------------------------------------------------------------------ */
function edgesFromScip(scipJsonPath) {
  const dec = run(scipBin, ['print', '--json', scipJsonPath], repo);
  if (!dec.ok) throw new Error(`scip print failed: ${dec.stderr.slice(0, 400)}`);
  let index;
  try {
    index = JSON.parse(dec.stdout);
  } catch {
    throw new Error(`scip print produced no JSON (index corrupt or empty): ${dec.stdout.slice(0, 200)}`);
  }

  // symbol → defining file (role 1 = definition)
  const symbolFile = new Map();
  for (const doc of index.documents ?? []) {
    const p = rel(doc.relative_path);
    if (p.startsWith('..')) continue;
    for (const o of doc.occurrences ?? []) {
      if (o.symbol_roles === 1 || o.symbolRoles === 1) symbolFile.set(o.symbol, p);
    }
  }

  const edges = new Set();
  for (const doc of index.documents ?? []) {
    const from = rel(doc.relative_path);
    if (from.startsWith('..')) continue;
    for (const o of doc.occurrences ?? []) {
      const role = o.symbol_roles ?? o.symbolRoles ?? 0;
      if (role === 1) continue; // definitions are not edges
      const to = symbolFile.get(o.symbol);
      if (to && to !== from) edges.add(`${from}\0${to}`);
    }
  }
  return edges;
}

/** ------------------------------------------------------------------ */
/** Oracle runners                                                      */
/** ------------------------------------------------------------------ */
function oracleTs() {
  // tsc --traceResolution logs every module resolution; pair the
  // "Resolving module 'X' from 'F'" with its "successfully resolved to 'T'".
  const edges = new Set();
  const resolvedSpecs = new Map(); // fromFile → Set<spec> (spec-level cross-check)

  // tsconfigs: root + one level under packages/ or apps/ (workspace repos)
  const tsconfigs = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.cells' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.name === 'tsconfig.json' && (depth === 0 || /(^|\/)(packages|apps)(\/|$)/.test(join(dir, e.name)))) {
        tsconfigs.push(join(dir, e.name));
      }
    }
  };
  walk(repo, 0);
  if (tsconfigs.length === 0) throw new Error(`no tsconfig.json found in ${repo}`);

  for (const tc of tsconfigs) {
    const out = run(tscBin, ['--noEmit', '--traceResolution', '-p', tc], repo);
    // tsc exits nonzero on type errors — the trace is still complete
    traceEdges(out.stdout, edges, resolvedSpecs);
    // files the project config never sees (tests, unlisted dirs) aren't in the
    // program → their imports untraced. Trace them with plain flags so every
    // repo file's imports are covered.
    const listed = run(tscBin, ['--listFiles', '-p', tc], repo)
      .stdout.split('\n')
      .map((f) => f.trim())
      .filter(inRepo)
      .map(rel);
    const uncovered = allSourceFiles(repo).filter((f) => !listed.includes(f));
    if (uncovered.length > 0) {
      const fallback = run(
        tscBin,
        ['--noEmit', '--traceResolution', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--skipLibCheck', ...uncovered.map((f) => join(repo, f))],
        repo,
      );
      traceEdges(fallback.stdout, edges, resolvedSpecs);
    }
  }
  return { edges, resolvedSpecs };
}

/** Parse a --traceResolution transcript into file→file edges + resolved specifiers. */
function traceEdges(stdout, edges, resolvedSpecs) {
  let cur = null;
  for (const line of stdout.split('\n')) {
    let m = line.match(/^======== Resolving module '([^']+)' from '([^']+)'\. ========$/);
    if (m) {
      cur = { spec: m[1], from: m[2] };
      continue;
    }
    m = line.match(/^======== Module name '[^']+' was successfully resolved to '([^']+)'\. ========$/);
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

function oracleScip(probe, buildArgs) {
  const tmp = mkdtempSync(join(tmpdir(), 'vc-scip-'));
  const scipFile = join(tmp, 'index.scip');
  const r = run(probe, buildArgs(scipFile), repo);
  if (!r.ok) {
    const err = r.stderr.slice(0, 600) || r.stdout.slice(0, 600);
    throw new Error(`${probe} failed: ${err}`);
  }
  return { edges: edgesFromScip(scipFile), resolvedSpecs: undefined };
}

const oracleRust = () => oracleScip(raBin, (scipFile) => ['scip', '--output', scipFile, '.']); // RA needs the positional project path
const oracleGo = () => oracleScip(scipGoBin, (scipFile) => ['--output', scipFile, '.']);

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
  const oracle = lang === 'ts' ? oracleTs() : lang === 'rust' ? oracleRust() : oracleGo();
  const ours = cellsEdges();

  const oracleOnly = [...oracle.edges].filter((k) => !ours.edges.has(k));
  const oursOnly = [...ours.edges].filter((k) => !oracle.edges.has(k));

  // classification cross-check (ts only): a specifier cells left unresolved
  // that the compiler itself resolved
  const falseUnresolved = [];
  if (oracle.resolvedSpecs) {
    for (const [, u] of ours.unresolved) {
      const from = u.fromFile;
      const specs = oracle.resolvedSpecs.get(from);
      if (specs?.has(u.import)) falseUnresolved.push(`${from} imports "${u.import}"`);
    }
  }

  const lines = [];
  lines.push(`# crossing validation — ${lang} on ${repo}`);
  lines.push(`  our edges: ${ours.edges.size}   oracle edges: ${oracle.edges.size}`);
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
