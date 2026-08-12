import { describe, expect, it } from 'vitest';
import { compare, normalize, scoped } from '../../scripts/validate-crossings/compare.ts';

const E = (...pairs: [string, string][]) => new Set(pairs.map(([f, t]) => `${f}\0${t}`));

describe('normalize — per-language granularity', () => {
  it('go: collapses targets to package dirs, drops same-dir edges', () => {
    const out = normalize(E(['src/a/x.go', 'src/b/y.go'], ['src/a/x.go', 'src/a/z.go']), 'go');
    expect([...out]).toEqual(['src/a/x.go\0src/b']);
  });

  it('java: drops same-dir (same-package, no-import) edges, keeps cross-package', () => {
    const out = normalize(E(['src/a/Main.java', 'src/a/Helper.java'], ['src/a/Main.java', 'src/b/Util.java']), 'java');
    expect([...out]).toEqual(['src/a/Main.java\0src/b/Util.java']);
  });

  it('other langs: passthrough', () => {
    const k = E(['src/a.ts', 'src/b.ts']);
    expect(normalize(k, 'ts')).toEqual(k);
  });
});

describe('scoped — comparison scope', () => {
  it('drops node_modules, dist, target edges on either side', () => {
    const out = scoped(E(['src/a.ts', 'node_modules/x/index.d.ts'], ['dist/out.js', 'src/b.ts'], ['src/c.ts', 'target/gen.java'], ['src/a.ts', 'src/b.ts']), 'oracle', 'ts');
    expect([...out]).toEqual(['src/a.ts\0src/b.ts']);
  });

  it('oracle side: drops non-TS targets; ours side: keeps only TS sources', () => {
    const edges = E(['src/a.ts', 'src/data.json'], ['src/a.ts', 'src/b.ts']);
    expect([...scoped(edges, 'oracle', 'ts')]).toEqual(['src/a.ts\0src/b.ts']);
    expect([...scoped(edges, 'ours', 'ts')]).toEqual(['src/a.ts\0src/data.json', 'src/a.ts\0src/b.ts']); // insertion order
  });
});

describe('blindFiles + compare', () => {
  it('flags files the oracle never indexed as blind and drops their edges from both sides', () => {
    const ours = { edges: E(['src/a.ts', 'src/b.ts'], ['src/a.ts', 'src-super/alt.ts'], ['src-super/alt.ts', 'src/c.ts']), unresolved: new Map() };
    const oracle = { edges: E(['src/a.ts', 'src/b.ts']), fromFiles: new Set(['src/a.ts', 'src/b.ts']) };
    const r = compare(ours as never, oracle as never, 'ts');
    expect(r.blind.sort()).toEqual(['src-super/alt.ts', 'src/c.ts']);
    expect([...r.oracleOnly]).toEqual([]);
    expect([...r.oursOnly]).toEqual([]);
    expect([...r.ourEdges]).toEqual(['src/a.ts\0src/b.ts']);
  });

  it('false unresolved: specifiers the oracle resolved that cells flagged', () => {
    const ours = {
      edges: E(['src/a.ts', 'src/b.ts']),
      unresolved: new Map([['src/a.ts\0./x', { fromFile: 'src/a.ts', import: './x' }]]),
    };
    const oracle = {
      edges: E(['src/a.ts', 'src/b.ts']),
      resolvedSpecs: new Map([['src/a.ts', new Set(['./x'])]]) as never,
    };
    const r = compare(ours as never, oracle as never, 'ts');
    expect(r.falseUnresolved).toEqual(['src/a.ts imports "./x"']);
  });
});
