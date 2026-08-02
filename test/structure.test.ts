import { describe, it, expect } from 'vitest';
import type { Crossing, CellMetrics } from '../src/crossings.js';
import type { Cell } from '../src/declaration.js';
import { detectCycles, cycleCutCandidates, checkDirection, checkSDP, formatSdpReport, formatStructureReport, formatLayerOverview, formatLayerSuggestions, computeImpact, formatImpactReport } from '../src/structure.js';

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

describe('cycleCutCandidates', () => {
  it('ranks internal cell-pair edges by file-crossing count (ascending)', () => {
    // cycle a↔b↔c; a→b has 1 file, b→c has 3, c→a has 1 (plus an a→c edge)
    const cycle = { cells: ['a', 'b', 'c'] };
    const crossings = [c('a', 'b'), c('b', 'c'), c('b', 'c'), c('b', 'c'), c('c', 'a'), c('a', 'c')];
    const out = cycleCutCandidates(cycle, crossings);
    expect(out[0]).toMatchObject({ fromCell: 'a', toCell: 'b', fileCount: 1 });
    expect(out.find((x) => x.fromCell === 'b' && x.toCell === 'c')?.fileCount).toBe(3);
    expect(out.at(-1)).toMatchObject({ fromCell: 'b', toCell: 'c', fileCount: 3 });
  });

  it('ignores edges to cells outside the cycle', () => {
    const cycle = { cells: ['a', 'b'] };
    expect(cycleCutCandidates(cycle, [c('a', 'b'), c('a', 'z'), c('z', 'b')])).toEqual([{ fromCell: 'a', toCell: 'b', fileCount: 1 }]);
  });

  it('ignores self-edges', () => {
    const cycle = { cells: ['a', 'b'] };
    expect(cycleCutCandidates(cycle, [c('a', 'b'), c('a', 'a')])).toEqual([{ fromCell: 'a', toCell: 'b', fileCount: 1 }]);
  });

  it('returns [] when the cycle has no internal edges', () => {
    expect(cycleCutCandidates({ cells: ['a', 'b'] }, [c('a', 'z')])).toEqual([]);
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

describe('checkSDP', () => {
  /** Instability: I = fanOut / (fanIn + fanOut). 0 = stable, 1 = unstable. */
  const m = (instability: number): CellMetrics => ({ fanIn: 0, fanOut: 0, instability });

  it('flags a stable cell depending on a less-stable one (I(from) < I(to))', () => {
    const metrics = { stable: m(0.0), unstable: m(0.8) };
    expect(checkSDP([c('stable', 'unstable')], metrics)).toEqual([{ fromCell: 'stable', toCell: 'unstable', fromInstability: 0.0, toInstability: 0.8 }]);
  });

  it('allows an edge toward stability (I(from) > I(to))', () => {
    const metrics = { unstable: m(0.8), stable: m(0.0) };
    expect(checkSDP([c('unstable', 'stable')], metrics)).toEqual([]);
  });

  it('allows an equal-instability edge (borderline, not a violation)', () => {
    const metrics = { a: m(0.5), b: m(0.5) };
    expect(checkSDP([c('a', 'b')], metrics)).toEqual([]);
  });

  it('dedupes multiple crossings between the same cell pair', () => {
    const metrics = { stable: m(0.1), unstable: m(0.9) };
    expect(checkSDP([c('stable', 'unstable'), c('stable', 'unstable')], metrics)).toHaveLength(1);
  });

  it('sorts violations by gap (worst inversion first)', () => {
    const metrics = { a: m(0.0), b: m(0.3), d: m(0.9), e: m(0.4) };
    // a→d gap 0.9 (worst); b→e gap 0.1
    const out = checkSDP([c('a', 'd'), c('b', 'e')], metrics);
    expect(out[0]).toMatchObject({ fromCell: 'a', toCell: 'd' });
    expect(out[1]).toMatchObject({ fromCell: 'b', toCell: 'e' });
  });

  it('skips an edge when a cell has no metric', () => {
    const metrics = { stable: m(0.1) };
    expect(checkSDP([c('stable', 'unknown')], metrics)).toEqual([]);
  });
});

describe('formatSdpReport', () => {
  const m = (instability: number): CellMetrics => ({ fanIn: 0, fanOut: 0, instability });

  it('returns null when there are no violations', () => {
    expect(formatSdpReport([])).toBeNull();
  });

  it('caps a long list with a count (pandas: 100+ entries dominate the output)', () => {
    const metrics: Record<string, CellMetrics> = {};
    const crossings = [];
    for (let i = 0; i < 30; i++) {
      metrics[`c${i}`] = m(0.1);
      metrics[`d${i}`] = m(0.9);
      crossings.push(c(`c${i}`, `d${i}`));
    }
    const report = formatSdpReport(checkSDP(crossings, metrics));
    const lines = report!.split('\n');
    expect(lines.length).toBe(1 + 20 + 1 + 1); // header + 20 capped + ellipsis + trailing
    expect(lines[21]).toContain('10 more');
    expect(lines[21]).toContain('30 total');
  });

  it('renders violations with instability values', () => {
    const metrics = { stable: m(0.0), unstable: m(0.8) };
    const report = formatSdpReport(checkSDP([c('stable', 'unstable')], metrics));
    expect(report).toContain('SDP');
    expect(report).toContain('stable (I=0.00)');
    expect(report).toContain('unstable (I=0.80)');
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

  it('caps a giant cycle (transformers: 500+ cells) and keeps the cut candidates', () => {
    const cells = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const out = formatStructureReport([{ cells }], [], true, {}, [{ fromCell: 'c1', toCell: 'c2', fromFile: 'x.ts', toFile: 'y.ts', import: "from 'x'" }]);
    expect(out).toContain('c0 ↔ c1');
    expect(out).not.toContain('c59'); // tail folded
    expect(out).toContain('40 more cells');
    expect(out).toContain('cheapest edges'); // actionable part survives the cap
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
    expect(formatImpactReport({ cell: 'a', affected: [] })).toBe('a is a leaf — no import dependents (static view; hidden callers like reflection, registries, and entry points are invisible). Safe to change — verify before deleting.\n');
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

describe('formatLayerSuggestions', () => {
  it('returns null when no cell sits below a dependency', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 },
    };
    expect(formatLayerSuggestions(decls)).toBeNull();
  });

  it('flags a cell whose layer is below a dependency (Direction risk)', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 2 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 }, // b(1) below a(2)
    };
    const out = formatLayerSuggestions(decls);
    expect(out).toContain('b: 1 → 2');
    expect(out).toContain('depends on a at layer 2');
  });

  it('does not flag a same-layer dependency (sideways is Direction-valid)', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 1 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 },
    };
    expect(formatLayerSuggestions(decls)).toBeNull();
  });

  it('does not flag a cell higher than its dependency', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 5 },
    };
    expect(formatLayerSuggestions(decls)).toBeNull();
  });

  it('skips layerless cells (only compares cells with a declared layer)', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 0 },
      b: { name: 'b', purpose: '', provides: [], requires: ['a'] }, // no layer
    };
    expect(formatLayerSuggestions(decls)).toBeNull();
  });

  it('never flags a cell with no internal dependencies, whatever its layer', () => {
    const decls: Record<string, Cell> = {
      a: { name: 'a', purpose: '', provides: [], requires: [], layer: 3 },
    };
    expect(formatLayerSuggestions(decls)).toBeNull();
  });
});
