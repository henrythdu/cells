import { describe, it, expect } from 'vitest';
import { assignFiles, unassignFiles, validCellName, planAssignment } from '../src/assign.js';
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
