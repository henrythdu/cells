import { describe, it, expect, afterEach } from 'vitest';
import { assignFiles, unassignFiles, validCellName, planAssignment, planGroups } from '../src/assign.js';
import { STUB_PURPOSE } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

describe('assignFiles', () => {
  it('adds files to a cell', () => {
    const ownership: Ownership = { a: ['src/a.ts'] };
    expect(assignFiles(ownership, 'a', ['src/b.ts'])).toEqual({ a: ['src/a.ts', 'src/b.ts'] });
  });

  it('moves a file out of its current cell into the target (preserves non-overlap)', () => {
    const ownership: Ownership = { a: ['src/x.ts'], b: ['src/y.ts'] };
    expect(assignFiles(ownership, 'b', ['src/x.ts'])).toEqual({
      a: [],
      b: ['src/y.ts', 'src/x.ts'],
    });
  });

  it('does not duplicate a file already in the target cell', () => {
    const ownership: Ownership = { a: ['src/x.ts'] };
    expect(assignFiles(ownership, 'a', ['src/x.ts'])).toEqual({ a: ['src/x.ts'] });
  });

  it('creates the target cell if it did not exist', () => {
    const ownership: Ownership = { a: ['src/a.ts'] };
    expect(assignFiles(ownership, 'newcell', ['src/a.ts'])).toEqual({
      a: [],
      newcell: ['src/a.ts'],
    });
  });
});

describe('unassignFiles', () => {
  it('removes files from their cell → orphan', () => {
    const ownership: Ownership = { a: ['src/x.ts', 'src/y.ts'], b: ['src/z.ts'] };
    expect(unassignFiles(ownership, ['src/x.ts'])).toEqual({ a: ['src/y.ts'], b: ['src/z.ts'] });
  });

  it('drops a cell that empties out (its declaration is a separate concern)', () => {
    const ownership: Ownership = { a: ['src/x.ts'], b: ['src/y.ts'] };
    expect(unassignFiles(ownership, ['src/x.ts'])).toEqual({ b: ['src/y.ts'] });
  });

  it('is a no-op for files that are already orphan', () => {
    const ownership: Ownership = { a: ['src/x.ts'] };
    expect(unassignFiles(ownership, ['src/orphan.ts'])).toEqual({ a: ['src/x.ts'] });
  });

  it('removes files spread across multiple cells', () => {
    const ownership: Ownership = { a: ['src/a1.ts', 'src/a2.ts'], b: ['src/b1.ts'] };
    expect(unassignFiles(ownership, ['src/a1.ts', 'src/b1.ts'])).toEqual({ a: ['src/a2.ts'] });
  });
});

describe('validCellName', () => {
  it('accepts identifiers (letters, numbers, dashes, underscores)', () => {
    expect(validCellName('cli')).toBe(true);
    expect(validCellName('tree-sitter')).toBe(true);
    expect(validCellName('cell_2')).toBe(true);
  });

  it('rejects path separators, dots, spaces, and empty (TOML-key + traversal safety)', () => {
    expect(validCellName('src/foo.ts')).toBe(false);
    expect(validCellName('a.b')).toBe(false);
    expect(validCellName('../etc')).toBe(false);
    expect(validCellName('')).toBe(false);
    expect(validCellName('has space')).toBe(false);
  });
});

describe('planAssignment', () => {
  const base: Ownership = { a: ['src/a.ts'] };

  it('plans a stub + updated ownership when the cell is new', () => {
    const result = planAssignment(base, 'cli', ['src/a.ts'], false);
    expect(result.stub).toEqual({ name: 'cli', purpose: STUB_PURPOSE, provides: [], requires: [] });
    expect(result.ownership).toEqual(assignFiles(base, 'cli', ['src/a.ts']));
  });

  it('plans no stub when the cell already exists', () => {
    const result = planAssignment(base, 'a', ['src/b.ts'], true);
    expect(result.stub).toBeNull();
    expect(result.ownership).toEqual(assignFiles(base, 'a', ['src/b.ts']));
  });

  it('does no I/O — trusts the passed cellExists, not the filesystem or ownership', () => {
    // cellExists=true even though 'ghost' is absent from ownership: the plan must use the boolean
    const result = planAssignment({}, 'ghost', ['src/x.ts'], true);
    expect(result.stub).toBeNull();
    expect(result.ownership).toEqual({ ghost: ['src/x.ts'] });
  });

  it('throws on an invalid cell name (the mutation contract)', () => {
    expect(() => planAssignment(base, 'bad/name', ['src/a.ts'], false)).toThrow();
  });
});

describe('planGroups', () => {
  let repo: string;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });
  const touch = (p: string, content = ''): void => {
    const full = join(repo, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  it('groups by directory when no manifests are present (unchanged)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('src/a.ts');
    touch('src/nested/b.ts');
    touch('test/x.ts');
    touch('root.ts');
    const g = planGroups(['src/a.ts', 'src/nested/b.ts', 'test/x.ts', 'root.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['root', 'src', 'src/nested', 'test']);
  });

  it('collapses Rust workspace crates to one cell each (uv wave-1 #5)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('crates/uv/src/main.rs');
    touch('crates/uv/benches/bench.rs'); // benches fold into the crate
    touch('crates/uv-tools/src/lib.rs');
    touch('crates/uv/Cargo.toml', '[package]\n');
    touch('crates/uv-tools/Cargo.toml', '[package]\n');
    const g = planGroups(['crates/uv/src/main.rs', 'crates/uv/benches/bench.rs', 'crates/uv-tools/src/lib.rs'], repo);
    expect([...g.keys()].sort()).toEqual(['crates/uv', 'crates/uv-tools']);
    expect(g.get('crates/uv')).toEqual(['crates/uv/src/main.rs', 'crates/uv/benches/bench.rs']);
  });

  it('collapses TS monorepo packages (vite packages/*)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('packages/a/src/x.ts');
    touch('packages/b/src/y.ts');
    touch('packages/a/package.json', '{}');
    touch('packages/b/package.json', '{}');
    const g = planGroups(['packages/a/src/x.ts', 'packages/b/src/y.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['packages/a', 'packages/b']);
  });

  it('a package nested inside another package folds into the parent (vite templates)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('packages/create-vite/src/index.ts');
    touch('packages/create-vite/template-react/main.tsx');
    touch('packages/create-vite/template-vue/main.ts');
    touch('packages/create-vite/package.json', '{}');
    touch('packages/create-vite/template-react/package.json', '{}');
    touch('packages/create-vite/template-vue/package.json', '{}');
    const g = planGroups(['packages/create-vite/src/index.ts', 'packages/create-vite/template-react/main.tsx', 'packages/create-vite/template-vue/main.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['packages/create-vite']);
    expect(g.get('packages/create-vite')).toHaveLength(3);
  });

  it('nested cargo crates stay separate (hard boundary, any size)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('crates/uv/src/main.rs');
    touch('crates/uv/xtask/src/main.rs'); // nested crate under crates/uv
    touch('crates/uv/Cargo.toml', '[package]\n');
    touch('crates/uv/xtask/Cargo.toml', '[package]\n');
    const g = planGroups(['crates/uv/src/main.rs', 'crates/uv/xtask/src/main.rs'], repo);
    expect([...g.keys()].sort()).toEqual(['crates/uv', 'crates/uv/xtask']);
  });

  it('a lone root manifest keeps directory grouping (no whole-repo collapse)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('package.json', '{}');
    touch('src/a.ts');
    touch('src/nested/b.ts');
    const g = planGroups(['src/a.ts', 'src/nested/b.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['src', 'src/nested']);
  });

  it('a single subdir crate groups as the crate (crate-aware even alone)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('crates/foo/src/lib.rs');
    touch('src/loose.rs');
    touch('crates/foo/Cargo.toml', '[package]\n');
    const g = planGroups(['crates/foo/src/lib.rs', 'src/loose.rs'], repo);
    // the crate is a hard boundary; loose files fall back to their dir
    expect([...g.keys()].sort()).toEqual(['crates/foo', 'src']);
  });

  it('folds invalid-name dirs to the nearest valid ancestor (Next.js routes)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    const g = planGroups(['app/[[...slug]]/page.tsx', 'app/page.tsx', '[[x]]/y.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['app', 'root']);
    expect(g.get('app')).toEqual(['app/[[...slug]]/page.tsx', 'app/page.tsx']);
  });

  it('folds dotted dirs too — every key must produce a creatable cell name', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    const g = planGroups(['packages/foo.v2/src/x.ts', '.storybook/preview.ts', 'src/a.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['packages', 'root', 'src']);
    // the guarantee: every emitted name passes validCellName after escaping
    for (const key of g.keys()) {
      expect(validCellName(key.replaceAll('-', '--').replaceAll('/', '-'))).toBe(true);
    }
  });
});


describe('cmdAssign size pre-flight (CLI integration)', () => {
  let repo: string;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('warns when the move would push the destination over its ceiling', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-assign-pf-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 't', type: 'module' }));
    writeFileSync(join(repo, 'src', 'existing.ts'), 'export const e = 1;\n');
    writeFileSync(join(repo, 'src', 'big.ts'), `export const pad = '${'x'.repeat(600)}';\n`);
    writeFileSync(join(repo, '.cells', 'config.toml'), `code-dirs = ["src"]\nmax-payload-tokens = 100\n`);
    writeFileSync(join(repo, '.cells', 'a.cell.toml'), `name = "a"\npurpose = "p"\nprovides = []\nrequires = []\nlayer = 0\n`);
    writeFileSync(join(repo, '.cells', 'ownership.toml'), `[a]\nfiles = ["src/existing.ts"]\n`);

    const bin = join(__dirname, '..', 'dist', 'cli.js');
    const out = execSync(`node ${bin} assign --dry-run a src/big.ts`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('⚠ a would be');
    expect(out).toContain('% of the ceiling');
  });
});
