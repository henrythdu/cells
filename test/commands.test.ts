import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdPayload, cmdShow, extractSurface } from '../src/commands/read.js';
import { loadContext } from '../src/io.js';
import { cmdAssign } from '../src/mutate.js';

describe("extractSurface — the raw material for a cell's signatures field", () => {
  it('extracts TS export declarations, Rust pub items, Python defs, Go funcs', () => {
    const src = [
      'export function parseCell(raw: string): Cell {',
      'export const DEFAULT = 1;',
      'export interface Foo {}',
      'function privateHelper() {}', // not exported — skipped
      'pub fn resolve(imp: &str) -> Option<String> {',
      'pub struct Config {',
      'fn internal() {}', // not pub — skipped
      'def parse_cell(raw):',
      'class Parser:',
      '    def method(self):', // indented method — skipped
      'func Resolve(path string) string {',
      'func helper() {}',
      '  const x = 1;', // indented — skipped
      '',
    ].join('\n');
    const hits = extractSurface(src);
    const texts = hits.map((h) => h.text);
    expect(texts).toContain('export function parseCell(raw: string): Cell {');
    expect(texts).toContain('export const DEFAULT = 1;');
    expect(texts).toContain('export interface Foo {}');
    expect(texts).toContain('pub fn resolve(imp: &str) -> Option<String> {');
    expect(texts).toContain('pub struct Config {');
    expect(texts).toContain('def parse_cell(raw):');
    expect(texts).toContain('class Parser:');
    expect(texts).toContain('func Resolve(path string) string {');
    expect(texts).toContain('func helper() {}'); // top-level Go func IS part of the surface
    expect(texts).not.toContain('function privateHelper() {}');
    expect(texts).not.toContain('fn internal() {}');
    expect(texts).not.toContain('def method(self):'); // indented method — not top-level
    expect(texts).not.toContain('const x = 1;'); // indented const — not top-level
    // line numbers are 1-based
    expect(hits[0].line).toBe(1);
  });
});

let repo: string;
const startCwd = process.cwd();

function git(args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
}

/** A python fixture: cells a + b + c (no imports anywhere) + a committed history where
 *  b.py + c.py co-change in 5 commits (>= the floor) and a.py never moves — so cmdShow
 *  can render dead-at-boundary (nobody imports c.py) and an UNEXPLAINED change-coupled
 *  pair (b ↔ c, no crossing edge). a.py exists so b+c commits aren't 100% of owned
 *  files; the wide-commit filter needs >10 files or >30% — 2/3 stays under both. */
function setupShowRepo(): void {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.cells'), { recursive: true });
  writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".py"]\nmodule-root = "src"\n');
  writeFileSync(join(repo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'c.cell.toml'), 'name = "c"\npurpose = "p"\nprovides = ["z"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.py"]\n[b]\nfiles = ["src/b.py"]\n[c]\nfiles = ["src/c.py"]\n');
  writeFileSync(join(repo, 'src', 'a.py'), 'x = 1\n');
  writeFileSync(join(repo, 'src', 'b.py'), 'y = 1\n'); // must differ from the i=2 write or git stages nothing
  writeFileSync(join(repo, 'src', 'c.py'), 'z = 3\n');
  git('init');
  git('config user.email t@t');
  git('config user.name t');
  git('add -A');
  git('commit -m one'); // a + b + c co-change (all new)
  for (let i = 2; i <= 5; i++) {
    writeFileSync(join(repo, 'src', 'b.py'), `y = ${i}\n`);
    writeFileSync(join(repo, 'src', 'c.py'), `z = ${i}\n`);
    git('add -A');
    git('commit -m two'); // b + c co-change (4 more times)
  }
}

describe('commands/read — the assembly the CLI tests only reach indirectly', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-cmds-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('cmdShow renders dead-at-boundary + co-change sections from the ctx it assembles', async () => {
    setupShowRepo();
    const ctx = loadContext();
    const out: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = (s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    };
    try {
      await cmdShow(ctx, 'c');
    } finally {
      process.stdout.write = orig;
    }
    const rendered = out.join('');
    expect(rendered).toContain('no other cell imports (static view — check for entry points before deleting):');
    expect(rendered).toContain('  src/c.py'); // dead — nothing imports it
    expect(rendered).toContain("change-coupled cells in git history (5 analyzed commits — logical coupling imports can't see):");
    expect(rendered).toContain('  ⚠ b — unexplained, no import edge (5/5, 100%)'); // b.py + c.py co-changed in 5/5 commits
  });

  it('cmdPayload appends the change-coupling hint for an unexplained partner (ADR 0002 wiring)', async () => {
    setupShowRepo();
    const ctx = loadContext();
    const out: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = (s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    };
    try {
      await cmdPayload(ctx, 'c');
    } finally {
      process.stdout.write = orig;
    }
    const rendered = out.join('');
    expect(rendered).toContain('## Change coupling');
    expect(rendered).toContain("⚠ b co-changes with you (5/5 commits, no import edge) — pull b's payload before touching its code, its context is invisible to you; co-changing files: src/b.py, src/c.py");
  });

  it('cmdAssign refuses a skip-listed target (ownership partitions the census) — and honors skip-dirs = [] unhide', () => {
    setupShowRepo();
    mkdirSync(join(repo, 'src', 'build'), { recursive: true });
    writeFileSync(join(repo, 'src', 'build', 'gen.py'), 'GEN = 1\n');
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (s: string) => {
      errs.push(String(s));
    };
    try {
      cmdAssign('newcell', ['src/build/gen.py']);
    } finally {
      console.error = origErr;
    }
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('outside the code census');
    expect(errs.join('\n')).toContain('skip-dirs');
    // The unhide path: skip-dirs = [] replaces the defaults → src/build/ enters the census → assign works.
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".py"]\nmodule-root = "src"\nskip-dirs = []\n');
    process.exitCode = 0;
    cmdAssign('newcell', ['src/build/gen.py']);
    expect(process.exitCode).toBe(0);
  });
});

describe('help CLI — the wiring', () => {
  it('exits 0 and prints the COMMANDS block', () => {
    const bin = join(__dirname, '..', 'dist', 'cli.js');
    const out = execSync(`node ${bin} help`, { encoding: 'utf8' });
    expect(out).toContain('COMMANDS');
    expect(out).toContain('imports [--json]');
    expect(out).toContain('prune-stale [--apply]');
  });
});
