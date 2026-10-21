import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findStaleRequires, removeCell, renameCell } from '../src/celledit.js';

/**
 * The cell edit seam, tested at its interface. A refusal throws the CLI refusal message, and
 * `main().catch` prints it with the `cells: ` prefix. The spawned-CLI tests in mutate,
 * remove, and workflow pin that behavior from end to end. A success returns an outcome
 * summary.
 */
let repo: string;

/**
 * Set up two cells. Cell a owns src/a.ts, and cell b owns src/b.ts and requires a. The
 * declaration of a contains a comment from an author, which proves that the edit uses text
 * surgery and not parse and serialise.
 */
function setupRepo(): void {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.cells'), { recursive: true });
  writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
  writeFileSync(join(repo, '.cells', 'a.cell.toml'), '# authored membrane\nname = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\n');
  writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = ["a"]\n');
  writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n");
}

const startCwd = process.cwd();

describe('renameCell — the seam interface', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-edit-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('renames declaration + ownership + dependents, preserving author comments', () => {
    setupRepo();
    const outcome = renameCell('a', 'c');
    expect(outcome).toEqual({ ownedCount: 1, requiresUpdated: 1 });
    expect(readFileSync(join(repo, '.cells', 'c.cell.toml'), 'utf8')).toContain('# authored membrane'); // The edit uses text surgery and not parse and serialise.
    expect(readFileSync(join(repo, '.cells', 'c.cell.toml'), 'utf8')).toContain('name = "c"');
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).toContain('requires = ["c"]');
    expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).toContain('[c]');
    expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).not.toContain('[a]');
  });

  it('throws the CLI refusal messages: invalid name, missing cell, existing target', () => {
    setupRepo();
    expect(() => renameCell('bad/name', 'x')).toThrow(/invalid cell name "bad\/name"/);
    expect(() => renameCell('ghost', 'x')).toThrow('no cell named "ghost"');
    expect(() => renameCell('a', 'b')).toThrow(/"b" already exists — can't overwrite/);
  });

  it('refuses an ownership-only [newName] entry before any write (no silent clobber)', () => {
    setupRepo();
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n[c]\nfiles = ["src/orphan.ts"]\n');
    expect(() => renameCell('a', 'c')).toThrow(/ownership.toml already has a \[c\] entry with no cell declaration/);
    expect(existsSync(join(repo, '.cells', 'a.cell.toml'))).toBe(true);
  });

  it('rename rewrites data-requires references in dependents too', () => {
    setupRepo();
    writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = []\ndata-requires = ["a"]\n');
    const outcome = renameCell('a', 'c');
    expect(outcome.requiresUpdated).toBe(1);
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).toContain('data-requires = ["c"]');
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).not.toContain('data-requires = ["a"]');
  });

  it('atomic order: the new declaration exists before the old one is removed', () => {
    setupRepo();
    renameCell('a', 'c');
    // This post-state proves the order. The crash window itself is untestable at this seam.
    // Exactly one declaration for the cell exists, and it declares the NEW name.
    expect(existsSync(join(repo, '.cells', 'c.cell.toml'))).toBe(true);
    expect(existsSync(join(repo, '.cells', 'a.cell.toml'))).toBe(false);
    expect(readFileSync(join(repo, '.cells', 'c.cell.toml'), 'utf8')).toMatch(/name = "c"/);
  });
});

describe('removeCell — the seam interface', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-edit-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuses when the cell owns files; --force orphans them and strips requires', () => {
    setupRepo();
    expect(() => removeCell('a', false)).toThrow(/"a" owns 1 file\(s\) — reassign them/);
    const outcome = removeCell('a', true);
    expect(outcome).toEqual({ ownedCount: 1, dependents: ['b'] });
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).toMatch(/requires = \[\]/);
    expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).not.toContain('[a]');
  });

  it('a data-requires dependent blocks removal without --force; --force strips it', () => {
    setupRepo();
    writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = []\ndata-requires = ["a"]\n');
    // The cell a must own nothing. Otherwise the refusal for owned files would hide the refusal for dependents.
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[b]\nfiles = ["src/b.ts"]\n');
    expect(() => removeCell('a', false)).toThrow(/required by b/);
    const outcome = removeCell('a', true);
    expect(outcome.dependents).toEqual(['b']);
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).toContain('data-requires = []');
  });

  it('throws on invalid/missing names (trust boundary)', () => {
    setupRepo();
    expect(() => removeCell('../victim', false)).toThrow(/invalid cell name/);
    expect(() => removeCell('ghost', false)).toThrow('no cell named "ghost"');
  });
});

describe('findStaleRequires — the analysis half', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-edit-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('classifies declared-but-unimported requires as stale (b→a has a real import, so it is NOT stale)', async () => {
    setupRepo();
    const byCell = await findStaleRequires();
    expect(byCell.size).toBe(0);
    // declare a stale one: c requires a but nothing in c imports a
    writeFileSync(join(repo, '.cells', 'c.cell.toml'), 'name = "c"\npurpose = "p"\nprovides = ["z"]\nrequires = ["a"]\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n[c]\nfiles = []\n');
    const next = await findStaleRequires();
    expect(next.get('c')).toEqual(['a']);
  });
});
