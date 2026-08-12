import { describe, expect, it } from 'vitest';
import { oracleCppFromRaw, tuArgv, withTuPath } from '../../scripts/validate-crossings/oracles/cpp.ts';

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
    expect(out.fromFiles!.has('src/cast.h')).toBe(true);
  });

  it('FAIL sections are blind (dead/disabled targets)', () => {
    const raw = ['# TU src/dead.c FAIL', '. /repo/src/attr.h', '# TU src/alive.c OK', '. /repo/src/attr.h'].join('\n');
    const out = oracleCppFromRaw(raw, REPO);
    expect([...out.edges]).toEqual(['src/alive.c\0src/attr.h']);
    expect(out.fromFiles!.has('src/dead.c')).toBe(false);
  });

  it('skips self-edges and out-of-repo headers', () => {
    const raw = ['# TU src/x.c OK', '. /repo/src/x.c', '. /usr/include/stdlib.h', '. /repo/src/y.h'].join('\n');
    const out = oracleCppFromRaw(raw, REPO);
    expect([...out.edges]).toEqual(['src/x.c\0src/y.h']);
  });
});

describe('tuArgv / withTuPath (shell-free compile commands)', () => {
  it('builds a shell-free argv: drops -o/depfile flags, swaps -c for -fsyntax-only -H', () => {
    expect(tuArgv(['gcc', '-c', '-o', 'x.o', '-MD', '-MF', 'x.d', '-I', 'inc', 'src/main.c'])).toEqual(['gcc', '-I', 'inc', 'src/main.c', '-fsyntax-only', '-H']);
  });

  it('keeps defines (-D) — macros affect includes', () => {
    expect(tuArgv(['gcc', '-DVERSION=3', '-c', 'src/main.c'])).toEqual(['gcc', '-DVERSION=3', 'src/main.c', '-fsyntax-only', '-H']);
  });

  it('returns null when the compdb entry has no arguments array (bash fallback)', () => {
    expect(tuArgv(undefined)).toBeNull();
    expect(tuArgv([])).toBeNull();
  });

  it('swaps the TU source path for the header path', () => {
    expect(withTuPath(['gcc', '/r/src/main.c', '-fsyntax-only', '-H'], '/r/src/main.c', '/r/src/attr.h')).toEqual(['gcc', '/r/src/attr.h', '-fsyntax-only', '-H']);
    expect(withTuPath(['gcc', '-fsyntax-only', '-H'], 'main.c', 'attr.h')).toEqual(['gcc', '-fsyntax-only', '-H']); // no match → unchanged
  });
});
