import { describe, it, expect } from 'vitest';
import type { Crossing } from '../src/crossings.js';
import type { Cell } from '../src/declaration.js';
import { detectCycles, checkDirection, formatStructureReport, formatLayerOverview, inferLayers, formatLayerSuggestions, computeImpact, formatImpactReport } from '../src/structure.js';

/** Build a minimal crossing (file/import fields are irrelevant to structure checks). */
const c = (fromCell: string, toCell: string): Crossing => ({
  fromCell,
  toCell,
  fromFile: 'f',
  toFile: 't',
  import: 'i',
});

/** Build a minimal cell with an optional layer. */
const cell = (name: string, layer?: number): Cell => ({
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
    expect(detectCycles([c('a', 'b'), c('b', 'c'), c('c', 'a')])).toEqual([{ cells: ['a', 'b', 'c'] }]);
  });

  it('detects two independent cycles (stable, sorted output)', () => {
    expect(detectCycles([c('a', 'b'), c('b', 'a'), c('c', 'd'), c('d', 'c')])).toEqual([{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }]);
  });

  it('removes duplicate edges (multi-file crossings between the same pair)', () => {
    expect(detectCycles([c('a', 'b'), c('a', 'b'), c('b', 'a')])).toEqual([{ cells: ['a', 'b'] }]);
  });

  it('returns [] for empty crossings', () => {
    expect(detectCycles([])).toEqual([]);
  });
});

describe('checkDirection', () => {
  it('flags an edge to a higher layer (core → peripheral)', () => {
    const decls = { core: cell('core', 0), periph: cell('periph', 2) };
    expect(checkDirection([c('core', 'periph')], decls)).toEqual([{ fromCell: 'core', fromLayer: 0, toCell: 'periph', toLayer: 2 }]);
  });

  it('allows an edge to a lower layer (peripheral → core)', () => {
    const decls = { core: cell('core', 0), periph: cell('periph', 2) };
    expect(checkDirection([c('periph', 'core')], decls)).toEqual([]);
  });

  it('allows a same-layer edge', () => {
    const decls = { a: cell('a', 1), b: cell('b', 1) };
    expect(checkDirection([c('a', 'b')], decls)).toEqual([]);
  });

  it('skips an edge where a cell has no layer (layerless = exempt)', () => {
    const decls = { a: cell('a'), b: cell('b', 0) };
    expect(checkDirection([c('a', 'b')], decls)).toEqual([]);
  });

  it('dedupes multiple crossings between the same cell pair', () => {
    const decls = { core: cell('core', 0), periph: cell('periph', 2) };
    expect(checkDirection([c('core', 'periph'), c('core', 'periph')], decls)).toHaveLength(1);
  });
});

describe('formatStructureReport', () => {
  it('clean, layers configured', () => {
    expect(formatStructureReport([], [], true)).toBe('ADP: acyclic — no circular dependencies.\nDirection: OK — no edges point to a higher layer.\n');
  });

  it('clean, no layers configured', () => {
    expect(formatStructureReport([], [], false)).toBe('ADP: acyclic — no circular dependencies.\nDirection: (skipped — no cells declare a layer).\n');
  });

  it('reports a cycle (cells joined)', () => {
    const out = formatStructureReport([{ cells: ['cli', 'io', 'view'] }], [], true);
    expect(out).toContain('ADP: 1 cycle(s):');
    expect(out).toContain('cli ↔ io ↔ view');
  });

  it('reports a direction violation (raw numbers when no legend)', () => {
    const out = formatStructureReport([], [{ fromCell: 'core', fromLayer: 0, toCell: 'periph', toLayer: 2 }], true);
    expect(out).toContain('Direction: 1 violation(s):');
    expect(out).toContain('core [0] → periph [2]');
  });

  it('labels a violation via the legend when provided', () => {
    const out = formatStructureReport([], [{ fromCell: 'core', fromLayer: 0, toCell: 'periph', toLayer: 2 }], true, { 0: 'domain', 2: 'ui' });
    expect(out).toContain('core [domain (0)] → periph [ui (2)]');
  });
});

describe('formatLayerOverview', () => {
  it('groups cells by tier (0 = core → higher = peripheral), layerless last', () => {
    const decls: Record<string, Cell> = {
      domain: { name: 'domain', purpose: '', provides: [], requires: [], layer: 0 },
      infra: { name: 'infra', purpose: '', provides: [], requires: [], layer: 2 },
      app: { name: 'app', purpose: '', provides: [], requires: [], layer: 1 },
      util: { name: 'util', purpose: '', provides: [], requires: [] }, // layerless
    };
    const out = formatLayerOverview(decls);
    expect(out).toContain('Layers (0 = core; higher = peripheral):');
    expect(out).toMatch(/0:.*domain/); // core tier
    expect(out).toMatch(/1:.*app/);
    expect(out).toMatch(/2:.*infra/); // peripheral
    expect(out).toMatch(/— \(layerless\):.*util/);
  });

  it('labels tiers via the legend when provided', () => {
    const decls: Record<string, Cell> = { a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 } };
    expect(formatLayerOverview(decls, { 0: 'domain' })).toContain('0 (domain): a');
  });

  it('returns "" when no cell declares a layer', () => {
    const decls: Record<string, Cell> = { a: { name: 'a', purpose: '', provides: [], requires: [] } };
    expect(formatLayerOverview(decls)).toBe('');
  });
});

describe('computeImpact', () => {
  it('returns the direct dependent (1 hop)', () => {
    // a→b: a depends on b, so changing b impacts a
    expect(computeImpact([c('a', 'b')], 'b')).toEqual({
      cell: 'b',
      affected: [{ cell: 'a', distance: 1 }],
    });
  });

  it('walks transitively (chain a→b→c: changing c impacts b then a)', () => {
    expect(computeImpact([c('a', 'b'), c('b', 'c')], 'c')).toEqual({
      cell: 'c',
      affected: [
        { cell: 'b', distance: 1 },
        { cell: 'a', distance: 2 },
      ],
    });
  });

  it('reports a leaf (nothing depends on it) as empty', () => {
    expect(computeImpact([c('a', 'b')], 'a')).toEqual({ cell: 'a', affected: [] });
  });

  it('dedupes a diamond (a reached at its min distance, once)', () => {
    // a→b, a→c, b→d, c→d: changing d impacts b,c (direct) then a (2 hops, once)
    const impact = computeImpact([c('a', 'b'), c('a', 'c'), c('b', 'd'), c('c', 'd')], 'd');
    expect(impact.affected).toEqual([
      { cell: 'b', distance: 1 },
      { cell: 'c', distance: 1 },
      { cell: 'a', distance: 2 },
    ]);
  });

  it('is safe under a cycle (no infinite loop)', () => {
    const impact = computeImpact([c('a', 'b'), c('b', 'a')], 'a');
    expect(impact.affected).toEqual([{ cell: 'b', distance: 1 }]);
  });
});

describe('formatImpactReport', () => {
  it('prints a leaf message when nothing depends on the cell', () => {
    expect(formatImpactReport({ cell: 'a', affected: [] })).toBe('a is a leaf — nothing depends on it (safe to change).\n');
  });

  it('groups affected cells by hop distance', () => {
    const out = formatImpactReport({
      cell: 'c',
      affected: [
        { cell: 'b', distance: 1 },
        { cell: 'a', distance: 2 },
      ],
    });
    expect(out).toContain('Impact: changing c affects 2 cell(s):');
    expect(out).toContain('direct: b');
    expect(out).toContain('2 hops: a');
  });
});

describe('inferLayers', () => {
  it('returns layer 0 for cells with no internal requires', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: [], layer: 0 },
    };
    expect(inferLayers(decls)).toEqual({ a: 0, b: 0 });
  });

  it('computes layer = 1 + max(required cells) over declared cells', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 },
      c: { name: 'c', purpose: '', provides: [], requires: ['b'], layer: 2 },
    };
    // c requires b (1) → 2; b requires a (0) → 1; a requires nothing → 0
    expect(inferLayers(decls)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('picks the max when a cell requires multiple cells', () => {
    const decls: Record<string, Cell> = {
      x: { name: 'x', purpose: '', provides: [], requires: [], layer: 0 },
      y: { name: 'y', purpose: '', provides: [], requires: [], layer: 0 },
      z: { name: 'z', purpose: '', provides: [], requires: ['x', 'y'], layer: 1 },
    };
    expect(inferLayers(decls)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('ignores external deps (cells not in declarations)', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: ['lib', 'db'], layer: 0 },
    };
    // external deps 'lib' and 'db' are not owned cells → ignored → a = 0
    expect(inferLayers(decls)).toEqual({ a: 0 });
  });

  it('returns null when requires has a cycle', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: ['b'], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 0 },
    };
    expect(inferLayers(decls)).toBeNull();
  });

  it('deep chain: a→b→c→d (4 layers)', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 },
      c: { name: 'c', purpose: '', provides: [], requires: ['b'], layer: 2 },
      d: { name: 'd', purpose: '', provides: [], requires: ['c'], layer: 3 },
    };
    expect(inferLayers(decls)).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });
});

describe('formatLayerSuggestions', () => {
  it('returns null when all layers match', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 },
    };
    const inferred = { a: 0, b: 1 };
    expect(formatLayerSuggestions(decls, inferred)).toBeNull();
  });

  it('shows current → suggested with reasoning', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 2 },
    };
    const inferred = { a: 0, b: 1 };
    const out = formatLayerSuggestions(decls, inferred);
    expect(out).toContain('b: 2 → 1');
    expect(out).toContain('from a');
  });

  it('skips layerless cells (only compares cells with a declared layer)', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'] }, // no layer
    };
    const inferred = { a: 0, b: 1 };
    expect(formatLayerSuggestions(decls, inferred)).toBeNull();
  });

  it('reports "no internal dependencies" when a cell requires nothing declared', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 3 },
    };
    const inferred = { a: 0 };
    const out = formatLayerSuggestions(decls, inferred);
    expect(out).toContain('a: 3 → 0');
    expect(out).toContain('no internal dependencies');
  });
});
