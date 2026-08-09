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
 *   java  scip-java               (import statements × compiler definition map)
 *   cpp   gcc -H                  (the compiler's own include tree)
 *   python pyright --dependencies (the interpreter's true import graph)
 *
 * This file is the thin CLI: argv → oracle registry → cache → compare →
 * report. The per-oracle raw runners + parsers live in oracles/ (parsers are
 * pure text→edges functions, unit-tested in test/validate-crossings/).
 *
 * Usage:
 *   node index.ts <repo-dir> <ts|rust|go> [options]
 *     --tsc <path>    tsc binary (default: $TSC or cells' node_modules/.bin/tsc)
 *     --cells <path>  cells dist/cli.js (default: $CELLS or ../../dist/cli.js)
 *     --scip <path>   scip CLI (default: $SCIP or scip on PATH)
 *     --top <n>       max sample lines per class (default 20)
 *     --no-cache      bypass raw-artifact + cells caches
 *
 * Exit code: 1 when the oracle found imports cells missed (under-flag).
 * The report is informational — it never gates cells itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBin, run } from './shared.ts';
import { makeCache } from './cache.ts';
import { cellsEdges, type CellsEdges } from './cells.ts';
import { compare, type Lang, type ParsedOracle } from './compare.ts';
import { edgesFromIndex, oracleScipRaw, type ScipIndex } from './oracles/scip.ts';
import { oracleTsRaw, oracleTsFromRaw, type TsRaw } from './oracles/ts.ts';
import { oracleJavaRaw, edgesFromJava } from './oracles/java.ts';
import { oracleCppRaw, oracleCppFromRaw } from './oracles/cpp.ts';
import { oraclePythonRaw, oraclePythonFromRaw } from './oracles/python.ts';

const [, , repoArg, langArg, ...rest] = process.argv;
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
const get = (k: string, d: string): string => args.get(k) ?? d;

/** The flag surface — single source for the usage line. */
const FLAGS = ['--tsc PATH', '--cells PATH', '--scip PATH', '--top N', '--no-cache'] as const;


const repo = resolve(repoArg ?? '.'); // main() exits on a missing repoArg before this is used
const lang = langArg as Lang;
const top = Number(get('--top', '20'));

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const cellsBin = resolve(get('--cells', process.env.CELLS ?? join(repoRoot, 'dist', 'cli.js')));
const scipBin = get('--scip', findBin('SCIP', 'scip', repo, run));
const tscBin = resolve(get('--tsc', process.env.TSC ?? join(repoRoot, 'node_modules', '.bin', 'tsc')));
const raBin = findBin('RUST_ANALYZER', 'rust-analyzer', repo, run);
const scipGoBin = findBin('SCIP_GO', 'scip-go', repo, run);
const javaBin = findBin('SCIP_JAVA', 'scip-java', repo, run);
const pyrightBin = findBin('PYRIGHT', 'pyright', repo, run);

/** Sample lines for the report — bounded, sorted. */
function sampleLines(set: string[], n: number, fmt: (k: string) => string): string[] {
  const all = [...set].sort();
  const shown = all.slice(0, n);
  const out = shown.map((k) => `  ${fmt(k)}`);
  if (all.length > n) out.push(`  …and ${all.length - n} more`);
  return out;
}

interface Oracle {
  name: string;
  version: () => string;
  raw: () => unknown;
  parse: (raw: unknown) => ParsedOracle;
}

const ORACLES: Record<Lang, Oracle> = {
  ts: {
    name: 'tsc',
    version: () => run(tscBin, ['--version'], repo).stdout.trim(),
    raw: () => oracleTsRaw(tscBin, repo, run),
    parse: (raw) => oracleTsFromRaw(raw as TsRaw, repo),
  },
  rust: {
    name: 'rust-analyzer',
    version: () => run(raBin, ['--version'], repo).stdout.trim(),
    raw: () => oracleScipRaw(raBin, (scipFile) => ['scip', '--output', scipFile, '.'], scipBin, repo, run), // RA needs the positional project path
    parse: (raw) => ({ edges: edgesFromIndex(raw as ScipIndex, repo) }),
  },
  go: {
    name: 'scip-go',
    version: () => run(scipGoBin, ['--version'], repo).stdout.trim(),
    raw: () => oracleScipRaw(scipGoBin, (scipFile) => ['index', '--output', scipFile, './...'], scipBin, repo, run), // scip-go indexes ONE package by default — ./... covers the module
    parse: (raw) => ({ edges: edgesFromIndex(raw as ScipIndex, repo, (s) => s.endsWith('/')) }), // go: package symbols only
  },
  java: {
    name: 'scip-java',
    version: () => `${run(javaBin, ['--version'], repo).stdout.trim()} ${(get('--java-args', '') ?? '').trim()}`,
    raw: () => oracleJavaRaw(javaBin, repo, run, (get('--java-args', '') ?? '').trim().split(/\s+/).filter(Boolean)),
    parse: (raw) => edgesFromJava(raw as ScipIndex, repo),
  },
  cpp: {
    name: 'gcc -H',
    version: () => `${run('gcc', ['--version'], repo).stdout.trim().split('\n')[0]} ${(get('--cmake-args', '') ?? '').trim()} oracle-v3`,
    raw: () => oracleCppRaw(repo, run, (get('--cmake-args', '') ?? '').trim().split(/\s+/).filter(Boolean)),
    parse: (raw) => oracleCppFromRaw(raw as string, repo),
  },
  python: {
    name: 'pyright',
    version: () => run(pyrightBin, ['--version'], repo).stdout.trim(),
    raw: () => oraclePythonRaw(repo, run, pyrightBin),
    parse: (raw) => oraclePythonFromRaw(raw as string, repo),
  },
};

function main(): void {
  if (!repoArg || !(langArg in ORACLES)) {
    console.error(`usage: node index.ts <repo-dir> <${Object.keys(ORACLES).join('|')}> [${FLAGS.join('] [')}]`);
    process.exit(2);
  }
  const oracle = ORACLES[lang];
  const oracleVersion = `${oracle.name} ${oracle.version()}`;
  const cache = makeCache(repo, lang, join(repoRoot, 'src'), run, rest.includes('--no-cache'));

  const raw =
    cache.loadRaw('oracle', oracleVersion) ??
    (() => {
      const r = oracle.raw();
      cache.saveRaw('oracle', oracleVersion, r);
      return r;
    })();
  // RAW artifacts are cached; extraction re-runs with CURRENT logic every load.
  const oracleParsed = oracle.parse(raw);

  let cellsVersion = 'cells ?';
  try {
    cellsVersion = `cells ${JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version}`;
  } catch {
    /* version read is a cache-key nicety — fall back to a fixed key */
  }
  const ours: CellsEdges =
    (cache.loadCells(cellsVersion) as CellsEdges | undefined) ??
    (() => {
      const o = cellsEdges(cellsBin, repo, run);
      cache.saveCells(cellsVersion, { edges: [...o.edges], unresolved: [...o.unresolved] });
      return o;
    })();
  if (Array.isArray(ours.unresolved)) {
    ours.unresolved = new Map(ours.unresolved); // cache round-trip
  }

  const r = compare(ours, oracleParsed, lang);

  const lines: string[] = [];
  lines.push(`# crossing validation — ${lang} on ${repo}`);
  lines.push(`  our edges: ${r.ourEdges.size}   oracle edges: ${r.oracleEdges.size}${lang === 'go' ? '  (package-granular: target = package dir)' : ''}`);
  if (r.blind.length > 0) lines.push(`  ${r.blind.length} file(s) oracle-blind (not indexed by the oracle — e.g. alternate-source trees, SDK-gated modules) — their edges unverifiable, dropped from both sides`);
  lines.push('');
  lines.push(`## under-flag (oracle resolved, cells missed): ${r.oracleOnly.length}`);
  if (r.oracleOnly.length > 0) lines.push(...sampleLines(r.oracleOnly, top, (k) => k.replace('\0', ' → ')));
  lines.push('');
  lines.push(`## over-flag (cells resolved, oracle did not): ${r.oursOnly.length}`);
  if (r.oursOnly.length > 0) lines.push(...sampleLines(r.oursOnly, top, (k) => k.replace('\0', ' → ')));
  lines.push('');
  if (r.falseUnresolved.length > 0) {
    lines.push(`## false unresolved (compiler resolved what cells flagged): ${r.falseUnresolved.length}`);
    lines.push(...sampleLines(r.falseUnresolved, top, (k) => k));
    lines.push('');
  }
  const verdict = r.oracleOnly.length === 0 ? '✓ parity — no imports missed' : `✗ ${r.oracleOnly.length} import(s) missed — inspect (tree-sitter gap or edge case)`;
  lines.push(verdict);

  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = r.oracleOnly.length > 0 ? 1 : 0;
}

main();
