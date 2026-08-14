import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findStaleRequires, removeCell, renameCell } from '../src/celledit.js';

/** The cell edit seam, tested at its interface: throws the CLI refusal messages
 *  (main().catch prints them with the `cells: ` prefix — the spawned-CLI tests in
 *  mutate/remove/workflow pin that end-to-end) and returns outcome summaries. */
let repo: string;

/** Two cells — a (owns src/a.ts) required by b (owns src/b.ts, requires a) — plus
 *  an author comment in a's declaration to prove text surgery over parse+serialize. */
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
    expect(readFileSync(join(repo, '.cells', 'c.cell.toml'), 'utf8')).toContain('# authored membrane'); // text surgery, not parse+serialize
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
    expect(existsSync(join(repo, '.cells', 'a.cell.toml'))).toBe(true); // nothing written
  });

  it('rename rewrites data-requires references in dependents too', () => {
    setupRepo();
    writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = []\ndata-requires = ["a"]\n');
    const outcome = renameCell('a', 'c');
    expect(outcome.requiresUpdated).toBe(1); // the data-requires ref counts as an updated declaration
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).toContain('data-requires = ["c"]');
    expect(readFileSync(join(repo, '.cells', 'b.cell.toml'), 'utf8')).not.toContain('data-requires = ["a"]');
  });

  it('atomic order: the new declaration exists before the old one is removed', () => {
    setupRepo();
    renameCell('a', 'c');
    // post-state proof of ordering (the crash window itself is untestable at this seam):
    // exactly one declaration for the cell exists and it declares the NEW name
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
    // a must own nothing — the owns-files refusal would otherwise mask the dependents refusal
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
