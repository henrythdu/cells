import { describe, it, expect } from 'vitest';
import { oracleCppFromRaw } from '../../scripts/validate-crossings/oracles/cpp.ts';

const REPO = '/repo';

describe('oracleCppFromRaw — per-TU gcc -H transcripts → edges', () => {
  it('depth-1 lines are direct-include edges; deeper dots are not', () => {
    const raw = [
      '# TU src/main.c OK',
      '. /usr/include/stdio.h',
      '. /repo/src/attr.h',
      '.. /repo/src/cast.h', // transitively reached — not a direct include
      '# TU src/attr.h OK',
      '. /repo/src/cast.h',
    ].join('\n');
    const out = oracleCppFromRaw(raw, REPO);
    expect([...out.edges]).toEqual(['src/main.c\0src/attr.h', 'src/attr.h\0src/cast.h']);
    // every file the compiler opened is oracle-visible (not blind)
    expect(out.fromFiles.has('src/cast.h')).toBe(true);
  });

  it('FAIL sections are blind (dead/disabled targets)', () => {
    const raw = ['# TU src/dead.c FAIL', '. /repo/src/attr.h', '# TU src/alive.c OK', '. /repo/src/attr.h'].join('\n');
    const out = oracleCppFromRaw(raw, REPO);
    expect([...out.edges]).toEqual(['src/alive.c\0src/attr.h']);
    expect(out.fromFiles.has('src/dead.c')).toBe(false);
  });

  it('skips self-edges and out-of-repo headers', () => {
    const raw = ['# TU src/x.c OK', '. /repo/src/x.c', '. /usr/include/stdlib.h', '. /repo/src/y.h'].join('\n');
    const out = oracleCppFromRaw(raw, REPO);
    expect([...out.edges]).toEqual(['src/x.c\0src/y.h']);
  });
});
