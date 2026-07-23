import { describe, it, expect } from 'vitest';
import { assignFiles, unassignFiles } from '../src/assign.js';
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
