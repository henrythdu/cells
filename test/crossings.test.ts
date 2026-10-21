import { describe, expect, it } from 'vitest';
import { type Crossing, checkLeakage, checkOffMembrane, computeMetrics, deriveCrossings, diffCrossings } from '../src/crossings.js';
import type { Cell } from '../src/declaration.js';
import type { ImportEdge } from '../src/imports.js';
import type { Ownership } from '../src/ownership.js';

/** Build the declarations from a map of name to requires. */
function decls(cells: Record<string, string[]>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [name, requires] of Object.entries(cells)) {
    out[name] = { name, purpose: '...', provides: [], requires };
  }
  return out;
}

describe('deriveCrossings', () => {
  const ownership: Ownership = {
    parser: ['src/parser.ts'],
    util: ['src/util.ts'],
  };

  it('maps a cross-cell import edge to a crossing', () => {
    const edges: ImportEdge[] = [{ fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' }];
    expect(deriveCrossings(edges, ownership)).toEqual([
      {
        fromCell: 'parser',
        toCell: 'util',
        fromFile: 'src/parser.ts',
        toFile: 'src/util.ts',
        import: './util',
      },
    ]);
  });

  it('drops internal imports (same cell)', () => {
    const edges: ImportEdge[] = [{ fromFile: 'src/parser.ts', toFile: 'src/parser.ts', import: './self' }];
    expect(deriveCrossings(edges, ownership)).toEqual([]);
  });

  it('drops edges into unowned files (not cross-cell, no target cell)', () => {
    const edges: ImportEdge[] = [{ fromFile: 'src/parser.ts', toFile: 'src/unowned-helper.ts', import: './helper' }];
    expect(deriveCrossings(edges, ownership)).toEqual([]);
  });
});

describe('checkLeakage', () => {
  it('flags an undeclared dependency (crossing without a matching require)', () => {
    const crossings: Crossing[] = [{ fromCell: 'parser', toCell: 'util', fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' }];
    const declarations = decls({ parser: [], util: [] }); // The cell parser does not require util.
    const l = checkLeakage(crossings, declarations);
    expect(l.some((x) => x.kind === 'undeclared' && x.fromCell === 'parser' && x.toCell === 'util')).toBe(true);
  });

  it('flags a stale require (declared but never imported)', () => {
    const declarations = decls({ parser: ['util'], util: [] });
    const l = checkLeakage([], declarations);
    expect(l.some((x) => x.kind === 'stale' && x.fromCell === 'parser' && x.toCell === 'util')).toBe(true);
  });

  it('returns no leakage when crossings match requires', () => {
    const crossings: Crossing[] = [{ fromCell: 'parser', toCell: 'util', fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' }];
    const declarations = decls({ parser: ['util'], util: [] });
    expect(checkLeakage(crossings, declarations)).toEqual([]);
  });

  it('data-requires is never stale (no import to check against)', () => {
    const declarations = decls({ parser: [], util: [] });
    declarations.parser.dataRequires = ['util']; // The cells are coupled through data, and the cell imports nothing.
    expect(checkLeakage([], declarations)).toEqual([]);
  });

  it('data-requires does NOT satisfy an undeclared crossing (a real import is code → requires)', () => {
    const crossings: Crossing[] = [{ fromCell: 'parser', toCell: 'util', fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' }];
    const declarations = decls({ parser: [], util: [] });
    declarations.parser.dataRequires = ['util']; // The wrong key for a code dependency.
    const l = checkLeakage(crossings, declarations);
    expect(l.some((x) => x.kind === 'undeclared' && x.fromCell === 'parser' && x.toCell === 'util')).toBe(true);
  });
});

describe('checkOffMembrane — the provides contract check (warning-only)', () => {
  const ownership = { a: ['src/a.ts'], b: ['src/b.ts'] };

  it('flags named symbols consumed but not in the target provides', () => {
    const edges: ImportEdge[] = [{ fromFile: 'src/a.ts', toFile: 'src/b.ts', import: './b', symbols: ['parse', 'stringify'] }];
    const declarations = decls({ a: [], b: [] });
    declarations.b.provides = ['parse']; // The provides list omits stringify.
    const off = checkOffMembrane(edges, ownership, declarations);
    expect(off).toEqual([{ fromCell: 'a', toCell: 'b', importedCount: 2, missing: ['stringify'], emptyProvides: false }]);
  });

  it('an empty provides list is the membrane-incomplete form (all imports missing)', () => {
    const edges: ImportEdge[] = [{ fromFile: 'src/a.ts', toFile: 'src/b.ts', import: './b', symbols: ['parse'] }];
    const declarations = decls({ a: [], b: [] }); // The provides list of b is empty.
    const off = checkOffMembrane(edges, ownership, declarations);
    expect(off).toEqual([{ fromCell: 'a', toCell: 'b', importedCount: 1, missing: ['parse'], emptyProvides: true }]);
  });

  it('all symbols in provides → clean; symbolless edges (module deps) are exempt by construction', () => {
    const declarations = decls({ a: [], b: [] });
    declarations.b.provides = ['parse'];
    const clean = checkOffMembrane([{ fromFile: 'src/a.ts', toFile: 'src/b.ts', import: './b', symbols: ['parse'] }], ownership, declarations);
    expect(clean).toEqual([]);
    const moduleDep = checkOffMembrane([{ fromFile: 'src/a.ts', toFile: 'src/b.ts', import: './b' }], ownership, declarations);
    expect(moduleDep).toEqual([]);
  });

  it('same-cell and unowned-file edges are skipped', () => {
    const declarations = decls({ a: [], b: [] });
    const edges: ImportEdge[] = [
      { fromFile: 'src/a.ts', toFile: 'src/a.ts', import: './a2', symbols: ['x'] }, // The edge is inside one cell.
      { fromFile: 'src/orphan.ts', toFile: 'src/b.ts', import: './b', symbols: ['y'] }, // The source file is unowned.
    ];
    expect(checkOffMembrane(edges, ownership, declarations)).toEqual([]);
  });
});

describe('computeMetrics', () => {
  it('counts distinct-cell fan-in/fan-out and instability', () => {
    const x = (fromCell: string, toCell: string): Crossing => ({ fromCell, toCell, fromFile: 'f', toFile: 't', import: 'm' });
    const crossings: Crossing[] = [
      x('a', 'b'),
      x('a', 'b'), // The duplicate cell pair (two files) counts once.
      x('a', 'c'),
      x('b', 'c'),
      x('d', 'c'),
    ];
    const m = computeMetrics(crossings, ['a', 'b', 'c', 'd']);
    expect(m.a).toEqual({ fanIn: 0, fanOut: 2, instability: 1 }); // The cell depends on b and c.
    expect(m.b).toEqual({ fanIn: 1, fanOut: 1, instability: 0.5 }); // a depends on b, and b depends on c.
    expect(m.c).toEqual({ fanIn: 3, fanOut: 0, instability: 0 }); // a, b, and d depend on c.
    expect(m.d).toEqual({ fanIn: 0, fanOut: 1, instability: 1 }); // The cell depends on c.
  });

  it('isolated cell → instability 0', () => {
    const m = computeMetrics([], ['x']);
    expect(m.x).toEqual({ fanIn: 0, fanOut: 0, instability: 0 });
  });
});

describe('diffCrossings', () => {
  const x = (fromCell: string, toCell: string, fromFile: string, toFile: string): Crossing => ({
    fromCell,
    toCell,
    fromFile,
    toFile,
    import: 'm',
  });

  it('added = in working not head; removed = in head not working', () => {
    const head = [x('a', 'b', 'a.ts', 'b.ts'), x('a', 'c', 'a.ts', 'c.ts')];
    const working = [x('a', 'b', 'a.ts', 'b.ts'), x('a', 'd', 'a.ts', 'd.ts')];
    const delta = diffCrossings(working, head);
    expect(delta.added).toEqual([x('a', 'd', 'a.ts', 'd.ts')]);
    expect(delta.removed).toEqual([x('a', 'c', 'a.ts', 'c.ts')]);
  });

  it('unchanged edges appear in neither', () => {
    const same = [x('a', 'b', 'a.ts', 'b.ts')];
    expect(diffCrossings(same, same)).toEqual({ added: [], removed: [] });
  });

  it('keys by file-edge, not just cell-pair (a→b via two files is two edges)', () => {
    const head = [x('a', 'b', 'a.ts', 'b.ts')];
    const working = [x('a', 'b', 'a.ts', 'b.ts'), x('a', 'b', 'a2.ts', 'b.ts')];
    const delta = diffCrossings(working, head);
    expect(delta.added).toEqual([x('a', 'b', 'a2.ts', 'b.ts')]);
    expect(delta.removed).toEqual([]);
  });

  it('dedupes identical edges and sorts for stable output', () => {
    const head: Crossing[] = [];
    const working = [x('b', 'a', 'b.ts', 'a.ts'), x('a', 'c', 'a.ts', 'c.ts'), x('b', 'a', 'b.ts', 'a.ts')];
    const delta = diffCrossings(working, head);
    // The function removes the duplicate b -> a edge and sorts by fromCell and then by toCell: a -> c, then b -> a.
    expect(delta.added).toEqual([x('a', 'c', 'a.ts', 'c.ts'), x('b', 'a', 'b.ts', 'a.ts')]);
  });

  it('sort tie-breaks on `import` when cells + files are identical (stable order)', () => {
    // The cells and the files are the same, and the import specifier is different, so the edges
    // are distinct: the crossing key includes the import. The sort must use the import as a
    // tie-breaker for deterministic output.
    const zz: Crossing = { fromCell: 'a', toCell: 'b', fromFile: 'a.ts', toFile: 'b.ts', import: 'zzz' };
    const aa: Crossing = { fromCell: 'a', toCell: 'b', fromFile: 'a.ts', toFile: 'b.ts', import: 'aaa' };
    const delta = diffCrossings([zz, aa], []);
    expect(delta.added).toEqual([aa, zz]);
  });
});
