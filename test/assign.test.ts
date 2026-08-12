import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assignFiles, cellNameOf, planApply, planAssignment, planGroups, unassignFiles, validCellName } from '../src/assign.js';
import { STUB_PURPOSE } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';

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
    expect([...g.keys()].sort()).toEqual(['src', 'src/nested', 'test']); // root.ts stays UNOWNED (no root catch-all)
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

  it('root [workspace] Cargo.toml is not a crate — python files outside crates/ still get units (headroom)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    touch('crates/headroom-py/Cargo.toml', '[package]\n');
    touch('crates/headroom-py/src/lib.rs');
    touch('headroom/__init__.py');
    touch('headroom/transforms/__init__.py');
    touch('headroom/transforms/diff_compressor.py');
    const g = planGroups(['crates/headroom-py/src/lib.rs', 'headroom/transforms/diff_compressor.py'], repo);
    expect([...g.keys()].sort()).toEqual(['crates/headroom-py', 'headroom/transforms']);
  });

  it('root Cargo.toml WITH [package] is a real unit — keyed by package name (stress #17: was recognized then dropped → 126 orphans on cxx)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('Cargo.toml', '[package]\nname = "ripgrep"\n\n[workspace]\n');
    touch('src/main.rs');
    touch('crates/extra/src/lib.rs');
    touch('crates/extra/Cargo.toml', '[package]\n');
    const g = planGroups(['src/main.rs', 'crates/extra/src/lib.rs'], repo);
    expect(g.has('crates/extra')).toBe(true); // the sub-crate is its own unit
    expect(g.get('ripgrep')).toEqual(['src/main.rs']); // root crate = its own cell, named by package
    expect(g.has('.')).toBe(false); // never the catch-all
  });

  it('a LONE root crate (no workspace members) becomes one cell, not a dir explosion (stress #17 cousin)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('Cargo.toml', '[package]\nname = "cxx"\n');
    touch('src/lib.rs');
    touch('src/bridge/ffi.rs');
    touch('syntax/tokens.rs');
    const g = planGroups(['src/lib.rs', 'src/bridge/ffi.rs', 'syntax/tokens.rs'], repo);
    expect([...g.keys()].sort()).toEqual(['cxx']);
    expect(g.get('cxx')).toHaveLength(3);
  });

  it('root Cargo.toml with unparseable [package] name falls back to the old drop (name.workspace = true)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('Cargo.toml', '[package]\nname.workspace = true\n');
    touch('src/lib.rs');
    const g = planGroups(['src/lib.rs'], repo);
    expect(g.has('cxx')).toBe(false);
    expect([...g.keys()].sort()).toEqual(['src']); // dir-keyed, honest fallback
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

  it('Python __init__.py dirs are hard boundaries — nested packages stay separate (wave-2 B)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('zerver/__init__.py');
    touch('zerver/views/__init__.py');
    touch('zerver/lib/__init__.py');
    touch('analytics/__init__.py');
    touch('zerver/views/home.py');
    touch('zerver/lib/utils.py');
    touch('analytics/views.py');
    const g = planGroups(['zerver/views/home.py', 'zerver/lib/utils.py', 'analytics/views.py'], repo);
    expect([...g.keys()].sort()).toEqual(['analytics', 'zerver/lib', 'zerver/views']);
  });

  it('a root package.json no longer swallows Python packages (zulip 2-cell collapse)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('package.json', '{}');
    touch('zerver/__init__.py');
    touch('starlight_help/package.json', '{}');
    touch('zerver/views.py');
    touch('starlight_help/src/foo.ts');
    const g = planGroups(['zerver/views.py', 'starlight_help/src/foo.ts'], repo);
    // zerver groups by its package, not the root manifest; starlight_help by its package
    expect([...g.keys()].sort()).toEqual(['starlight_help', 'zerver']);
    expect(g.get('zerver')).toEqual(['zerver/views.py']);
  });

  it('a lone Python package groups as one cell (non-root unit alone)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('mypkg/__init__.py');
    touch('mypkg/a.py');
    touch('mypkg/sub/b.py'); // no __init__.py in sub — folds into mypkg
    const g = planGroups(['mypkg/a.py', 'mypkg/sub/b.py'], repo);
    expect([...g.keys()].sort()).toEqual(['mypkg']);
  });

  it('a root __init__.py keeps directory grouping (repo-as-one-package)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('__init__.py');
    touch('a.py');
    touch('sub/b.py');
    const g = planGroups(['a.py', 'sub/b.py'], repo);
    expect([...g.keys()].sort()).toEqual(['sub']); // a.py at the package root stays unowned
  });

  it('python bundled inside a crate stays in the crate (cargo owns its subtree)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('crates/uv/Cargo.toml', '[package]\n');
    touch('crates/uv/python/uv_build/__init__.py');
    touch('crates/uv/python/uv_build/build.py');
    const g = planGroups(['crates/uv/python/uv_build/__init__.py', 'crates/uv/python/uv_build/build.py'], repo);
    expect([...g.keys()].sort()).toEqual(['crates/uv']);
  });

  it('a python package with a co-located package.json stays a hard boundary (pyinit > pkg)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    touch('pkg/parent/package.json', '{}');
    touch('pkg/parent/child/package.json', '{}'); // both a TS package AND a python package
    touch('pkg/parent/child/__init__.py');
    touch('pkg/parent/child/mod.py');
    touch('pkg/parent/index.ts');
    const g = planGroups(['pkg/parent/child/__init__.py', 'pkg/parent/child/mod.py', 'pkg/parent/index.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['pkg/parent', 'pkg/parent/child']); // not folded into parent
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
    expect([...g.keys()].sort()).toEqual(['app']); // [[x]]/y.ts folds to '.' → unowned, not a root cell
    expect(g.get('app')).toEqual(['app/[[...slug]]/page.tsx', 'app/page.tsx']);
  });

  it('folds dotted dirs too — every key must produce a creatable cell name', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-plan-'));
    const g = planGroups(['packages/foo.v2/src/x.ts', '.storybook/preview.ts', 'src/a.ts'], repo);
    expect([...g.keys()].sort()).toEqual(['packages', 'src']); // .storybook folds to '.' → unowned
    // the guarantee: every emitted name passes validCellName after escaping
    for (const key of g.keys()) {
      expect(validCellName(cellNameOf(key))).toBe(true);
    }
  });
});

describe('planApply', () => {
  it('creates stubs for new cells and adopts unowned files, merging into existing ownership', () => {
    const ownership: Ownership = { curated: ['src/kept.ts'] };
    const proposed = new Map([
      ['curated', ['src/kept.ts', 'src/new.ts']],
      ['fresh', ['src/a.ts', 'src/b.ts']],
    ]);
    const r = planApply(ownership, proposed, new Set(['curated']));
    expect(r.stubs).toEqual([{ name: 'fresh', purpose: STUB_PURPOSE, provides: [], requires: [] }]);
    expect(r.skipped).toBe(1); // curated exists — not overwritten
    expect(r.adopted).toBe(3);
    expect(r.kept).toBe(1); // src/kept.ts already owned — not stolen
    expect(r.ownership).toEqual({ curated: ['src/kept.ts', 'src/new.ts'], fresh: ['src/a.ts', 'src/b.ts'] });
  });

  it('never overwrites an existing declaration, even when the cell is proposed again', () => {
    const r = planApply({ a: ['src/a.ts'] }, new Map([['a', ['src/a.ts']]]), new Set(['a']));
    expect(r.stubs).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('a proposed cell whose files are all kept gets no stub and no entry', () => {
    const r = planApply({ other: ['src/a.ts'] }, new Map([['ghost', ['src/a.ts']]]), new Set());
    expect(r.stubs).toEqual([]);
    expect(r.ownership).toEqual({ other: ['src/a.ts'] });
  });

  it('files owned by another cell stay put (the plan does not steal)', () => {
    const r = planApply({ a: ['src/a.ts'] }, new Map([['b', ['src/a.ts', 'src/b.ts']]]), new Set());
    expect(r.ownership).toEqual({ a: ['src/a.ts'], b: ['src/b.ts'] });
    expect(r.kept).toBe(1);
  });

  it('overlapping proposals never double-own a file (non-overlap invariant)', () => {
    const r = planApply(
      {},
      new Map([
        ['x', ['src/shared.ts', 'src/x.ts']],
        ['y', ['src/shared.ts', 'src/y.ts']],
      ]),
      new Set(),
    );
    expect(r.ownership.x).toEqual(['src/shared.ts', 'src/x.ts']);
    expect(r.ownership.y).toEqual(['src/y.ts']);
    expect(r.kept).toBe(1); // y's shared.ts was already adopted by x
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

describe('cmdAssign trust boundary (CLI integration)', () => {
  let repo: string;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('rejects assign targets outside the repo (exit 1, no ownership write)', () => {
    repo = mkdtempSync(join(tmpdir(), 'cells-assign-unsafe-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, 'src', 'x.ts'), 'export {};\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '');
    const bin = join(__dirname, '..', 'dist', 'cli.js');
    let stderr = '';
    try {
      execSync(`node ${bin} assign a ../x.ts`, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    } catch (err: any) {
      stderr = err.stderr?.toString() ?? '';
    }
    expect(stderr).toContain('outside the repo');
    expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).toBe('');
  });
});
