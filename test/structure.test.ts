import { describe, expect, it } from 'vitest';
import type { CellMetrics, Crossing } from '../src/crossings.js';
import type { Cell } from '../src/declaration.js';
import {
  checkDirection,
  checkSDP,
  classifyChangeCoupling,
  computeImpact,
  cycleCutCandidates,
  detectCycles,
  formatChangeCouplingReport,
  formatImpactReport,
  formatLayerOverview,
  formatLayerSuggestions,
  formatSdpReport,
  formatStructureReport,
  formatStructureSummary,
} from '../src/structure.js';

/** Build a minimal crossing. The file and import fields do not matter to the structure checks. */
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
    // The cycle is a <-> b <-> c. a -> b has 1 file, b -> c has 3 files, and c -> a has 1
    // file. There is also an a -> c edge.
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
  /** Instability I is fanOut divided by (fanIn + fanOut). A value of 0 is stable and a value of 1 is unstable. */
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
    // The gap of a -> d is 0.9, the worst. The gap of b -> e is 0.1.
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
    expect(lines.length).toBe(1 + 20 + 1 + 1); // One header line, 20 capped lines, one ellipsis line, and one trailing line.
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
    expect(out).not.toContain('c59'); // The tail is folded.
    expect(out).toContain('40 more cells');
    expect(out).toContain('cheapest edges'); // The actionable part survives the cap.
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

describe('formatStructureSummary', () => {
  it('clean, layers configured', () => {
    expect(formatStructureSummary([], [], true)).toBe('ADP: acyclic — no circular dependencies.\nDirection: OK — no edges point to a higher layer.\nSDP: 0 violation(s).\n');
  });

  it('one line per cycle: size + cheapest edges, sorted by size desc', () => {
    const crossings = [
      c('a1', 'a2'),
      c('a2', 'a3'),
      c('a3', 'a1'), // This edge closes the 3-cycle.
      c('b1', 'b2'),
      c('b2', 'b1'), // This edge closes the 2-cycle.
    ];
    const out = formatStructureSummary([{ cells: ['a1', 'a2', 'a3'] }, { cells: ['b1', 'b2'] }], [], true, crossings, 7);
    const lines = out.split('\n');
    expect(lines[0]).toBe('ADP: 2 cycle(s) — 5 cells total:');
    expect(lines[1]).toContain('3 cells'); // The largest cycle comes first.
    expect(lines[1]).toContain('cheapest: a1→a2 (1)');
    expect(lines[2]).toContain('2 cells');
    expect(lines[2]).not.toContain('↔'); // The summary shows no full chain.
    expect(lines[3]).toBe('Direction: OK — no edges point to a higher layer.');
    expect(lines[4]).toBe('SDP: 7 violation(s).');
  });

  it('direction violation collapses to a count', () => {
    const out = formatStructureSummary([], [{ fromCell: 'core', fromLayer: 0, toCell: 'periph', toLayer: 2 }], true);
    expect(out).toContain('Direction: 1 violation(s).');
    expect(out).not.toContain('core [0]'); // The summary gives no detail.
  });
});

describe('formatLayerOverview', () => {
  it('groups cells by tier (0 = core → higher = peripheral), layerless last', () => {
    const decls: Record<string, Cell> = {
      domain: { name: 'domain', purpose: '', provides: [], requires: [], layer: 0 },
      infra: { name: 'infra', purpose: '', provides: [], requires: [], layer: 2 },
      app: { name: 'app', purpose: '', provides: [], requires: [], layer: 1 },
      util: { name: 'util', purpose: '', provides: [], requires: [] }, // The cell has no layer.
    };
    const out = formatLayerOverview(decls);
    expect(out).toContain('Layers (0 = core; higher = peripheral):');
    expect(out).toMatch(/0:.*domain/); // The core tier.
    expect(out).toMatch(/1:.*app/);
    expect(out).toMatch(/2:.*infra/); // The peripheral tier.
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
    // a -> b: a depends on b, so a change to b affects a.
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
    // The edges are a -> b, a -> c, b -> d, and c -> d. A change to d affects b and c
    // directly, and then a at 2 hops, once.
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
      b: { name: 'b', purpose: '', provides: [], requires: ['a'], layer: 1 }, // b has layer 1, below a at layer 2.
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
      b: { name: 'b', purpose: '', provides: [], requires: ['a'] }, // The cell has no layer.
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

describe('classifyChangeCoupling', () => {
  /** A commit that touches the given files. The hash does not matter to the classification. */
  const commit = (files: string[]): { hash: string; files: string[] } => ({ hash: 'h', files });
  const ownership: Record<string, string[]> = {
    a: ['src/a.ts'],
    b: ['src/b.ts'],
    c: ['src/c.ts'],
    d: ['src/d.ts'],
  };
  /** Return n commits that each touch a and b, the coupled pair. Cell d stays untouched. */
  const coupledCommits = (n: number) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(commit(['src/a.ts', 'src/b.ts']));
    return out;
  };

  it('flags an unexplained pair (no crossing edge) above floor + Jaccard', () => {
    const r = classifyChangeCoupling(coupledCommits(6), ownership, []);
    expect(r.window).toBe(6);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ a: 'a', b: 'b', count: 6, union: 6, jaccard: 1, explained: false });
    expect(r.pairs[0].sampleFiles).toEqual(['src/a.ts', 'src/b.ts']); // The files that changed together, capped and sorted.
  });

  it('marks a pair explained when a crossing edge exists (dependency ripple is the null hypothesis)', () => {
    const r = classifyChangeCoupling(coupledCommits(6), ownership, [c('a', 'b')]);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].explained).toBe(true);
  });

  it('drops pairs below the co-change floor', () => {
    expect(classifyChangeCoupling(coupledCommits(4), ownership, [])).toEqual({ pairs: [], window: 4 });
  });

  it('drops pairs below the Jaccard threshold (rate, not raw count)', () => {
    // With 8 commits, 5 touch a and b, and 10 more touch b alone, the union is 15 and the
    // Jaccard value is 5/15 = 0.33, which is above the threshold. To increase the union, 12
    // b-only commits give a union of 17 and a Jaccard value of 0.29, which is below the
    // threshold.
    const commits = [...coupledCommits(5), ...Array.from({ length: 12 }, () => commit(['src/b.ts']))];
    expect(classifyChangeCoupling(commits, ownership, [])).toEqual({ pairs: [], window: 17 });
  });

  it('excludes wide commits (mass refactor/format) — but only above the absolute floor', () => {
    // There are 40 owned files. A commit that touches 15 of them (37.5%) with more than 10
    // files is wide, so the analysis excludes it.
    const bigOwnership: Record<string, string[]> = { a: ['src/a.ts'], b: ['src/b.ts'] };
    for (let i = 0; i < 38; i++) bigOwnership[`x${i}`] = [`src/x${i}.ts`];
    const wide = { hash: 'w', files: ['src/a.ts', 'src/b.ts', ...Array.from({ length: 13 }, (_, i) => `src/x${i}.ts`)] };
    // There are 6 normal a+b commits and 1 wide a+b commit. Without the exclusion the count
    // would be 7, and with it the count is 6.
    const r = classifyChangeCoupling([...coupledCommits(6), wide], bigOwnership, []);
    expect(r.window).toBe(6);
    expect(r.pairs[0].count).toBe(6);
    // In a small repository with 3 owned files, a commit of 2 files is 66%, but it is below
    // the 10-file floor, so it stays.
    const small = classifyChangeCoupling(coupledCommits(6), ownership, []);
    expect(small.window).toBe(6);
  });

  it('excludes lockfile/generated-only commits (dependency bumps)', () => {
    const commits = [
      ...coupledCommits(6),
      commit(['src/a.ts', 'src/b.ts', 'pnpm-lock.yaml']), // The commit is mixed, so it stays: it is not noise-only.
      commit(['pnpm-lock.yaml', 'package-lock.json']), // The commit contains only noise files. The analysis excludes it, and it touches no owned cell in any case.
      commit(['dist/app.wasm']), // The file is generated, so the analysis excludes the commit. The file is also unowned here.
    ];
    const r = classifyChangeCoupling(commits, ownership, []);
    expect(r.window).toBe(7); // Six commits and the mixed commit.
  });

  it('returns empty for no commits, no ownership, or nothing over threshold', () => {
    expect(classifyChangeCoupling([], ownership, [])).toEqual({ pairs: [], window: 0 });
    expect(classifyChangeCoupling(coupledCommits(6), {}, [])).toEqual({ pairs: [], window: 0 });
    // c and d change together only twice, which is below the floor.
    const r = classifyChangeCoupling([commit(['src/c.ts', 'src/d.ts']), commit(['src/c.ts', 'src/d.ts'])], ownership, []);
    expect(r.pairs).toEqual([]);
  });

  it('sorts unexplained first, then by count desc, then names', () => {
    const commits = [
      ...coupledCommits(8), // The pair a|b is unexplained, with count 8.
      ...Array.from({ length: 6 }, () => commit(['src/c.ts', 'src/d.ts'])), // The pair c|d has no edge, so it is unexplained with count 6.
    ];
    const r = classifyChangeCoupling(commits, ownership, [c('a', 'b')]); // This edge explains the pair a|b.
    expect(r.pairs.map((p) => `${p.a}|${p.b}`)).toEqual(['c|d', 'a|b']);
  });

  it('formatChangeCouplingReport renders the ranked list and nulls when clean', () => {
    expect(formatChangeCouplingReport({ pairs: [], window: 200 })).toBeNull();
    const r = classifyChangeCoupling(coupledCommits(6), ownership, [c('a', 'b')]);
    const report = formatChangeCouplingReport(r)!;
    expect(report).toContain('Change-coupled cells (6 analyzed commits;');
    expect(report).toContain('a ↔ b   explained — has import edge (6/6, 100%)');
    // The unexplained pair gets the warning mark.
    const r2 = classifyChangeCoupling(coupledCommits(6), ownership, []);
    expect(formatChangeCouplingReport(r2)!).toContain('⚠ a ↔ b   unexplained — no import edge (6/6, 100%)');
  });
});
