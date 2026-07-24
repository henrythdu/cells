import { describe, it, expect } from 'vitest';
import {
  deriveCrossings,
  checkLeakage,
  computeMetrics,
  diffCrossings,
  type ImportEdge,
  type Crossing,
} from '../src/crossings.js';
import type { Ownership } from '../src/ownership.js';
import type { Cell } from '../src/declaration.js';

/** Helper: build declarations from { name: [requires] }. */
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
    const edges: ImportEdge[] = [
      { fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' },
    ];
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
    const edges: ImportEdge[] = [
      { fromFile: 'src/parser.ts', toFile: 'src/parser.ts', import: './self' },
    ];
    expect(deriveCrossings(edges, ownership)).toEqual([]);
  });

  it('drops edges into unowned files (not cross-cell, no target cell)', () => {
    const edges: ImportEdge[] = [
      { fromFile: 'src/parser.ts', toFile: 'src/unowned-helper.ts', import: './helper' },
    ];
    expect(deriveCrossings(edges, ownership)).toEqual([]);
  });
});

describe('checkLeakage', () => {
  it('flags an undeclared dependency (crossing without a matching require)', () => {
    const crossings: Crossing[] = [
      { fromCell: 'parser', toCell: 'util', fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' },
    ];
    const declarations = decls({ parser: [], util: [] }); // parser doesn't require util
    const l = checkLeakage(crossings, declarations);
    expect(l.some((x) => x.kind === 'undeclared' && x.fromCell === 'parser' && x.toCell === 'util')).toBe(true);
  });

  it('flags a stale require (declared but never imported)', () => {
    const declarations = decls({ parser: ['util'], util: [] });
    const l = checkLeakage([], declarations);
    expect(l.some((x) => x.kind === 'stale' && x.fromCell === 'parser' && x.toCell === 'util')).toBe(true);
  });

  it('returns no leakage when crossings match requires', () => {
    const crossings: Crossing[] = [
      { fromCell: 'parser', toCell: 'util', fromFile: 'src/parser.ts', toFile: 'src/util.ts', import: './util' },
    ];
    const declarations = decls({ parser: ['util'], util: [] });
    expect(checkLeakage(crossings, declarations)).toEqual([]);
  });
});

describe('computeMetrics', () => {
  it('counts distinct-cell fan-in/fan-out and instability', () => {
    const x = (fromCell: string, toCell: string): Crossing => ({ fromCell, toCell, fromFile: 'f', toFile: 't', import: 'm' });
    const crossings: Crossing[] = [
      x('a', 'b'), x('a', 'b'), // dup cell-pair (two files) counts once
      x('a', 'c'),
      x('b', 'c'),
      x('d', 'c'),
    ];
    const m = computeMetrics(crossings, ['a', 'b', 'c', 'd']);
    expect(m.a).toEqual({ fanIn: 0, fanOut: 2, instability: 1 }); // →{b,c}
    expect(m.b).toEqual({ fanIn: 1, fanOut: 1, instability: 0.5 }); // ←a →c
    expect(m.c).toEqual({ fanIn: 3, fanOut: 0, instability: 0 }); // ←a,b,d
    expect(m.d).toEqual({ fanIn: 0, fanOut: 1, instability: 1 }); // →c
  });

  it('isolated cell → instability 0', () => {
    const m = computeMetrics([], ['x']);
    expect(m.x).toEqual({ fanIn: 0, fanOut: 0, instability: 0 });
  });
});

describe('diffCrossings', () => {
  const x = (fromCell: string, toCell: string, fromFile: string, toFile: string): Crossing => ({
    fromCell, toCell, fromFile, toFile, import: 'm',
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
    // deduped (b→a once) + sorted by fromCell then toCell: a→c, b→a
    expect(delta.added).toEqual([x('a', 'c', 'a.ts', 'c.ts'), x('b', 'a', 'b.ts', 'a.ts')]);
  });
});
