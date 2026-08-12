#!/usr/bin/env node
// Stress harness: synthesize a big synthetic Cells repo and run the tool's own
// gates against it, asserting time ceilings. CI runs this nightly + on demand
// (workflow_dispatch) — the kafka-scale (670 cells) adoption run used to be
// manual; this makes the regression signal reproducible.
//
// Usage: node scripts/stress.mjs [--cells N] [--files-per-cell K] [--repo DIR]
// The synthetic repo is a chain DAG: cell i imports from cell i-1 only, so
// `cells health` must pass clean (undeclared crossings would fail it).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i === -1 ? def : Number(args[i + 1]);
};
const CELLS = get('--cells', 600);
const FILES_PER_CELL = get('--files-per-cell', 10);
const repoArgIdx = args.indexOf('--repo');
const repo = repoArgIdx === -1 ? mkdtempSync(join(tmpdir(), 'cells-stress-')) : args[repoArgIdx + 1];
const cellsDir = join(repo, '.cells');
const srcDir = join(repo, 'src');

console.log(`generating ${CELLS} cells x ${FILES_PER_CELL} files in ${repo}`);
mkdirSync(cellsDir, { recursive: true });
writeFileSync(join(cellsDir, 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
const ownership = [];
for (let i = 0; i < CELLS; i++) {
  const name = `cell-${String(i).padStart(4, '0')}`;
  const prev = i === 0 ? null : `cell-${String(i - 1).padStart(4, '0')}`;
  const dir = join(srcDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cellsDir, `${name}.cell.toml`), `name = "${name}"\npurpose = "synthetic stress cell ${i}"\nprovides = ["value"]\nrequires = [${prev ? `"${prev}"` : ''}]\n`);
  const files = [];
  for (let f = 0; f < FILES_PER_CELL; f++) {
    const file = join(dir, `mod${f}.ts`);
    const body = prev ? `import { v${i - 1} } from '../${prev}/mod${f}.ts';\nexport const v${i} = v${i - 1} + ${f};\n` : `export const v0 = ${f};\n`;
    writeFileSync(file, body);
    files.push(`src/${name}/mod${f}.ts`);
  }
  ownership.push(`[${name}]\nfiles = [${files.map((f) => `"${f}"`).join(', ')}]\n`);
}
writeFileSync(join(cellsDir, 'ownership.toml'), ownership.join('\n'));

const run = (label, ...cmd) => {
  const t0 = performance.now();
  let status = 'ok';
  let out = '';
  try {
    out = execFileSync(process.execPath, cmd, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = `FAIL (${e.status ?? 'spawn'})`;
    out = String(e.stderr ?? e.stdout ?? e.message).slice(0, 500);
  }
  const ms = Math.round(performance.now() - t0);
  console.log(`${label.padEnd(14)} ${String(ms).padStart(6)}ms  ${status}`);
  return { ms, status, out };
};

const CLI = [join(process.cwd(), 'dist', 'cli.js')];
const health = run('health', ...CLI, 'health');
const size = run('size', ...CLI, 'size');
const graph = run('graph', ...CLI, 'graph');

// Ceilings: generous vs the kafka-scale baseline — the point is regression
// detection (order-of-magnitude blowups), not micro-benchmarking.
const LIMITS = { health: 120_000, size: 30_000, graph: 60_000 };
let failed = false;
for (const [name, r] of Object.entries({ health, size, graph })) {
  if (r.status !== 'ok') {
    console.error(`stress FAIL: ${name} ${r.status}\n${r.out}`);
    failed = true;
  } else if (r.ms > LIMITS[name]) {
    console.error(`stress FAIL: ${name} took ${r.ms}ms > ${LIMITS[name]}ms ceiling`);
    failed = true;
  } else {
    console.log(`stress ok: ${name} ${r.ms}ms (ceiling ${LIMITS[name]}ms)`);
  }
}
if (!args.includes('--repo')) rmSync(repo, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(`stress pass: ${CELLS} cells, ${CELLS * FILES_PER_CELL} files`);
