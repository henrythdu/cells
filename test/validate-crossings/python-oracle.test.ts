import { describe, it, expect } from 'vitest';
import { oraclePythonFromRaw } from '../../scripts/validate-crossings/oracles/python.ts';

const REPO = '/repo';

describe('oraclePythonFromRaw — pyright --dependencies --verbose → edges', () => {
  it('collects Imports sections, skips the Imported-by (reverse) sections', () => {
    const out = oraclePythonFromRaw(
      [
        'src/a.py',
        ' Imports 2 files',
        '    file:///repo/src/b.py',
        '    file:///repo/src/c.py',
        ' Imported by 1 files',
        '    file:///repo/src/main.py',
        'src/b.py',
        ' Imports 1 files',
        '    file:///repo/src/a.py',
      ].join('\n'),
      REPO,
    );
    expect([...out.edges]).toEqual(['src/a.py\0src/b.py', 'src/a.py\0src/c.py', 'src/b.py\0src/a.py']);
    expect([...out.fromFiles]).toEqual(['src/a.py', 'src/b.py']);
  });

  it('skips non-import noise lines and drops out-of-repo targets', () => {
    const out = oraclePythonFromRaw(
      [
        'Found 2 source files',
        'src/a.py',
        ' Imports 2 files',
        '    file:///repo/src/b.py',
        '    file:///usr/lib/python3/random.py',
      ].join('\n'),
      REPO,
    );
    expect([...out.edges]).toEqual(['src/a.py\0src/b.py']);
  });

  it('treats an out-of-repo section header as a blind section (site-packages copy)', () => {
    const out = oraclePythonFromRaw(
      [
        '/usr/lib/python3/site-packages/pkg/__init__.py',
        ' Imports 1 files',
        '    file:///usr/lib/python3/site-packages/pkg/mod.py',
        'src/a.py',
        ' Imports 0 files',
      ].join('\n'),
      REPO,
    );
    expect(out.edges.size).toBe(0);
    expect([...out.fromFiles]).toEqual(['src/a.py']);
  });
});
