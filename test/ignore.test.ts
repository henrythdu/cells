import { describe, it, expect } from 'vitest';
import { parseIgnore, isIgnored } from '../src/ignore.js';

describe('parseIgnore', () => {
  it('collects non-empty, non-comment lines (trimmed)', () => {
    const text = '# a comment\nexamples/**\n\n  *.tmp  \nscratch/foo.ts\n';
    expect(parseIgnore(text)).toEqual(['examples/**', '*.tmp', 'scratch/foo.ts']);
  });

  it('returns [] for empty / comment-only input', () => {
    expect(parseIgnore('# nothing here\n\n')).toEqual([]);
  });
});

describe('isIgnored', () => {
  const patterns = ['examples/**', '*.tmp', 'scratch/foo.ts'];

  it('matches a ** glob at any depth', () => {
    expect(isIgnored('examples/foo.ts', patterns)).toBe(true);
    expect(isIgnored('examples/sub/bar.ts', patterns)).toBe(true);
  });

  it('matches a suffix glob', () => {
    expect(isIgnored('notes.tmp', patterns)).toBe(true);
  });

  it('matches an exact path', () => {
    expect(isIgnored('scratch/foo.ts', patterns)).toBe(true);
  });

  it('does not match an unlisted path', () => {
    expect(isIgnored('src/cli.ts', patterns)).toBe(false);
  });

  it('returns false when there are no patterns', () => {
    expect(isIgnored('anything.ts', [])).toBe(false);
  });
});
