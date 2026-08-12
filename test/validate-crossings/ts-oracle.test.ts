import { describe, expect, it } from 'vitest';
import { scoped } from '../../scripts/validate-crossings/compare.ts';
import { traceEdges } from '../../scripts/validate-crossings/oracles/ts.ts';

const REPO = '/repo';

function parse(trace: string) {
  const edges = new Set<string>();
  const specs = new Map<string, Set<string>>();
  traceEdges(trace, edges, specs, REPO);
  return { edges, specs };
}

describe('traceEdges — tsc --traceResolution transcript → edges', () => {
  it('resolves module+from pairs into file→file edges with spec records', () => {
    const { edges, specs } = parse(
      [
        "======== Resolving module './a' from '/repo/src/main.ts'. ========",
        "======== Module name './a' was successfully resolved to '/repo/src/a.ts'. ========",
        "======== Resolving module 'node:fs' from '/repo/src/main.ts'. ========",
        "======== Module name 'node:fs' was successfully resolved to 'node:fs'. ========",
      ].join('\n'),
    );
    expect([...edges]).toEqual(['src/main.ts\0src/a.ts']);
    expect(specs.get('src/main.ts')).toEqual(new Set(['./a']));
  });

  it('keeps node_modules edges in the raw parse — the scoped() pass drops them', () => {
    const { edges } = parse(["======== Resolving module 'react' from '/repo/src/app.tsx'. ========", "======== Module name 'react' was successfully resolved to '/repo/node_modules/react/index.d.ts'. ========"].join('\n'));
    expect([...edges]).toEqual(['src/app.tsx\0node_modules/react/index.d.ts']); // raw parse: kept
    expect([...scoped(edges, 'oracle', 'ts')]).toEqual([]); // comparison: dropped (census never sees node_modules)
  });

  it('drops self-edges and relative paths escaping the repo', () => {
    const { edges } = parse(
      [
        "======== Resolving module './self' from '/repo/src/self.ts'. ========",
        "======== Module name './self' was successfully resolved to '/repo/src/self.ts'. ========",
        "======== Resolving module '../outside' from '/repo/src/x.ts'. ========",
        "======== Module name '../outside' was successfully resolved to '/other/outside.ts'. ========",
      ].join('\n'),
    );
    expect(edges.size).toBe(0);
  });

  it('handles the NodeNext resolved line trailer (with Package ID)', () => {
    const { edges } = parse(
      ["======== Resolving module '@pkg/util' from '/repo/src/x.ts'. ========", "======== Module name '@pkg/util' was successfully resolved to '/repo/packages/util/src/index.ts' with Package ID '@pkg/util@1.0.0'. ========"].join('\n'),
    );
    expect([...edges]).toEqual(['src/x.ts\0packages/util/src/index.ts']);
  });
});
