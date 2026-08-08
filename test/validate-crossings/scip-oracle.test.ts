import { describe, it, expect } from 'vitest';
import { edgesFromIndex } from '../../scripts/validate-crossings/oracles/scip.ts';

const REPO = '/repo';

const doc = (path: string, occurrences: { symbol: string; roles: number }[]) => ({
  relative_path: path,
  occurrences: occurrences.map((o) => ({ symbol: o.symbol, symbol_roles: o.roles })),
});

describe('edgesFromIndex — SCIP index → file→file edges', () => {
  it('maps definition→file and draws ref edges, skipping definitions and locals', () => {
    const index = {
      documents: [
        doc('src/a.go', [
          { symbol: 'pkg .foo', roles: 1 }, // definition in a
          { symbol: 'local 0', roles: 4 },
        ]),
        doc('src/b.go', [
          { symbol: 'pkg .bar', roles: 1 }, // definition in b
          { symbol: 'pkg .foo', roles: 4 }, // reference → a
          { symbol: 'local 0', roles: 4 },
        ]),
      ],
    };
    const edges = edgesFromIndex(index as never, REPO);
    expect([...edges]).toEqual(['src/b.go\0src/a.go']);
  });

  it('go: keeps only package-symbol refs (trailing /) via the keep filter', () => {
    const index = {
      documents: [
        doc('src/a.go', [{ symbol: 'pkg/', roles: 1 }]),
        doc('src/b.go', [
          { symbol: 'pkg/', roles: 4 }, // import ref — kept
          { symbol: 'pkg .Value', roles: 4 }, // value use — dropped
        ]),
      ],
    };
    const edges = edgesFromIndex(index as never, REPO, (s) => s.endsWith('/'));
    expect([...edges]).toEqual(['src/b.go\0src/a.go']);
  });

  it('prefers the non-test definition for symbols defined in every file (go packages)', () => {
    const index = {
      documents: [
        doc('src/pkg/a_test.go', [{ symbol: 'pkg/', roles: 1 }]),
        doc('src/pkg/a.go', [{ symbol: 'pkg/', roles: 1 }]),
        doc('src/use.go', [{ symbol: 'pkg/', roles: 4 }]),
      ],
    };
    const edges = edgesFromIndex(index as never, REPO, (s) => s.endsWith('/'));
    expect([...edges]).toEqual(['src/use.go\0src/pkg/a.go']); // not a_test.go
  });

  it('drops documents outside the repo and definitions-as-edges', () => {
    const index = {
      documents: [
        doc('../vendor/x.go', [{ symbol: 'v .x', roles: 1 }]),
        doc('src/a.go', [{ symbol: 'v .x', roles: 4 }, { symbol: 'own', roles: 1 }]),
      ],
    };
    const edges = edgesFromIndex(index as never, REPO);
    expect(edges.size).toBe(0);
  });
});
