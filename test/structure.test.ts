import { describe, it, expect } from 'vitest';
import type { Crossing } from '../src/crossings.js';
import type { Cell } from '../src/declaration.js';
import { detectCycles, checkDirection, formatStructureReport } from '../src/structure.js';

/** Build a minimal crossing (file/import fields are irrelevant to structure checks). */
const c = (fromCell: string, toCell: string): Crossing => ({
  fromCell,
  toCell,
  fromFile: 'f',
  toFile: 't',
  import: 'i',
});

/** Build a minimal cell with an optional layer. */
const cell = (name: string, layer?: string): Cell => ({
  name,
  purpose: '',
  provides: [],
  requires: [],
  layer,
});

describe('detectCycles', () => {
  it('returns [] for an acyclic graph', () => {
    expect(detectCycles([c('a', 'b'), c('b', 'c')])).toEqual([]);
  });

  it('detects a direct 2-cycle (A→B→A)', () => {
    expect(detectCycles([c('a', 'b'), c('b', 'a')])).toEqual([{ cells: ['a', 'b'] }]);
  });

  it('detects a transitive 3-cycle (A→B→C→A)', () => {
    expect(detectCycles([c('a', 'b'), c('b', 'c'), c('c', 'a')])).toEqual([
      { cells: ['a', 'b', 'c'] },
    ]);
  });

  it('detects two independent cycles (stable, sorted output)', () => {
    expect(detectCycles([c('a', 'b'), c('b', 'a'), c('c', 'd'), c('d', 'c')])).toEqual([
      { cells: ['a', 'b'] },
      { cells: ['c', 'd'] },
    ]);
  });

  it('ignores duplicate edges (multi-file crossings between the same pair)', () => {
    expect(detectCycles([c('a', 'b'), c('a', 'b'), c('b', 'a')])).toEqual([{ cells: ['a', 'b'] }]);
  });

  it('returns [] for empty crossings', () => {
    expect(detectCycles([])).toEqual([]);
  });
});

describe('checkDirection', () => {
  const order = ['core', 'app', 'domain']; // index 0 = lowest

  it('returns [] when no layers are configured', () => {
    expect(checkDirection([c('a', 'b')], { a: cell('a'), b: cell('b') }, [])).toEqual([]);
  });

  it('flags a high→low edge', () => {
    const decls = { domain: cell('domain', 'domain'), infra: cell('infra', 'core') };
    expect(checkDirection([c('domain', 'infra')], decls, order)).toEqual([
      { fromCell: 'domain', fromLayer: 'domain', toCell: 'infra', toLayer: 'core' },
    ]);
  });

  it('allows a low→high edge', () => {
    const decls = { domain: cell('domain', 'domain'), infra: cell('infra', 'core') };
    expect(checkDirection([c('infra', 'domain')], decls, order)).toEqual([]);
  });

  it('allows a same-layer edge', () => {
    const decls = { a: cell('a', 'app'), b: cell('b', 'app') };
    expect(checkDirection([c('a', 'b')], decls, order)).toEqual([]);
  });

  it('skips an edge where a cell has no layer tag', () => {
    const decls = { a: cell('a'), b: cell('b', 'core') };
    expect(checkDirection([c('a', 'b')], decls, order)).toEqual([]);
  });

  it('skips an edge where a layer is not in the order', () => {
    const decls = { a: cell('a', 'weird'), b: cell('b', 'core') };
    expect(checkDirection([c('a', 'b')], decls, order)).toEqual([]);
  });

  it('dedupes multiple crossings between the same cell pair', () => {
    const decls = { domain: cell('domain', 'domain'), infra: cell('infra', 'core') };
    expect(checkDirection([c('domain', 'infra'), c('domain', 'infra')], decls, order)).toHaveLength(1);
  });
});

describe('formatStructureReport', () => {
  it('clean, layers configured', () => {
    expect(formatStructureReport([], [], true)).toBe(
      'ADP: acyclic — no circular dependencies.\nDirection: OK — no high→low edges.\n',
    );
  });

  it('clean, no layers configured', () => {
    expect(formatStructureReport([], [], false)).toBe(
      'ADP: acyclic — no circular dependencies.\nDirection: (skipped — no layers configured in .cells/config.toml).\n',
    );
  });

  it('reports a cycle (cells joined)', () => {
    const out = formatStructureReport([{ cells: ['cli', 'io', 'view'] }], [], true);
    expect(out).toContain('ADP: 1 cycle(s):');
    expect(out).toContain('cli ↔ io ↔ view');
  });

  it('reports a direction violation', () => {
    const out = formatStructureReport(
      [],
      [{ fromCell: 'domain', fromLayer: 'domain', toCell: 'infra', toLayer: 'core' }],
      true,
    );
    expect(out).toContain('Direction: 1 violation(s):');
    expect(out).toContain('domain [domain] → infra [core]');
  });
});
