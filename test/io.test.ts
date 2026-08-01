import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProject, loadOwnership, writeOwnership } from '../src/io.js';
import { execSync } from 'node:child_process';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cells-detect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadOwnership (ignored files are unowned — wave-3 #7)', () => {
  it('excludes owned files matching .cells/ignore patterns', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cells-ig-own-'));
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts", "dist/b.js"]\n');
    writeFileSync(join(repo, '.cells', 'ignore'), 'dist/\n');
    const prev = process.cwd();
    process.chdir(repo);
    try {
      expect(loadOwnership()).toEqual({ a: ['src/a.ts'] });
    } finally {
      process.chdir(prev);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns ownership unchanged when no ignore file exists', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cells-ig-own-'));
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n');
    const prev = process.cwd();
    process.chdir(repo);
    try {
      expect(loadOwnership()).toEqual({ a: ['src/a.ts'] });
    } finally {
      process.chdir(prev);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writeOwnership drops ignored files — the invariant holds at both ends of the store', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cells-ig-own-'));
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, '.cells', 'ignore'), 'dist/\n');
    const prev = process.cwd();
    process.chdir(repo);
    try {
      writeOwnership({ a: ['src/a.ts', 'dist/b.js'], b: ['dist/c.js'] }); // whole cell ignored → dropped
      expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).toContain('src/a.ts');
      expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).not.toContain('dist/');
      expect(loadOwnership()).toEqual({ a: ['src/a.ts'] }); // disk and read model agree
    } finally {
      process.chdir(prev);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('detectProject', () => {
  it('detects a Python repo (.py + its dirs)', () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'src', 'app.py'), 'x = 1');
    writeFileSync(join(dir, 'tests', 'test_app.py'), 'x = 1');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeExts).toEqual(['.py']);
    expect(codeDirs).toEqual(['src', 'tests']);
  });

  it('detects a Rust repo (.rs)', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'main.rs'), 'fn main() {}');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeExts).toEqual(['.rs']);
    expect(codeDirs).toEqual(['src']);
  });

  it('detects a TS repo (.ts)', () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export{}');
    writeFileSync(join(dir, 'test', 'a.test.ts'), 'export{}');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeExts).toEqual(['.ts']);
    expect(codeDirs).toEqual(['src', 'test']);
  });

  it('skips node_modules / build output / tooling caches', () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'dist'));
    mkdirSync(join(dir, 'src'));
    // node_modules has 100 .js files — must be ignored
    for (let i = 0; i < 100; i++) writeFileSync(join(dir, 'node_modules', 'pkg', `m${i}.js`), 'x');
    writeFileSync(join(dir, 'dist', 'out.js'), 'x');
    writeFileSync(join(dir, 'src', 'real.ts'), 'export{}');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeDirs).toEqual(['src']); // node_modules + dist excluded
    expect(codeExts).toEqual(['.ts']); // not drowned by node_modules .js
  });

  it('sorts extensions by frequency (polyglot repo)', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.py'), 'x');
    writeFileSync(join(dir, 'src', 'b.py'), 'x');
    writeFileSync(join(dir, 'src', 'c.py'), 'x');
    writeFileSync(join(dir, 'src', 'd.ts'), 'export{}');
    const { codeExts } = detectProject(dir);
    expect(codeExts).toEqual(['.py', '.ts']); // .py first (more files)
  });

  it('detects code files at the repo root', () => {
    writeFileSync(join(dir, 'tool.py'), 'x = 1');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeExts).toEqual(['.py']);
    expect(codeDirs).toEqual(['.']);
  });

  it('collapses subdirs when root code files exist ("." covers them)', () => {
    // regression: ['.', 'src'] double-counted every file in ownership/plan
    writeFileSync(join(dir, 'tool.py'), 'x = 1');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.py'), 'x = 2');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeExts).toEqual(['.py']);
    expect(codeDirs).toEqual(['.']);
  });

  it('falls back to TS defaults when no code files found', () => {
    writeFileSync(join(dir, 'README.md'), '# hi');
    writeFileSync(join(dir, 'data.json'), '{}');
    const { codeExts, codeDirs } = detectProject(dir);
    expect(codeExts).toEqual(['.ts']);
    expect(codeDirs).toEqual(['src', 'test']);
  });
});

describe('malformed TOML attribution (CLI integration)', () => {
  let repo: string;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('names the offending .cell.toml file in the error', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-toml-attr-'));
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, '.cells', 'a.cell.toml'), '[a\nbroken toml\n'); // malformed
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\n');
    const bin = join(__dirname, '..', 'dist', 'cli.js');
    try {
      execSync(`node ${bin} list`, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
      expect.unreachable('expected exit 1');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('a.cell.toml');
    }
  });
});
