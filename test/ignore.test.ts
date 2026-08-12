import { describe, expect, it } from 'vitest';
import { isIgnored, parseIgnore } from '../src/ignore.js';

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
    expect(isIgnored('.notes.tmp', patterns)).toBe(false); // `*` keeps gitignore's leading-dot rule (dot only for ** patterns)
  });

  it('matches an exact path', () => {
    expect(isIgnored('scratch/foo.ts', patterns)).toBe(true);
  });

  it('last matching pattern wins — `!` re-includes (gitignore negation semantics)', () => {
    expect(isIgnored('keep.ts', ['*.ts', '!keep.ts'])).toBe(false); // re-included by the later negation
    expect(isIgnored('other.ts', ['*.ts', '!keep.ts'])).toBe(true); // only keep.ts is exempt
    expect(isIgnored('keep.ts', ['!keep.ts', '*.ts'])).toBe(true); // order matters — a later positive re-ignores
    expect(isIgnored('dist/keep.js', ['dist/', '!dist/keep.js'])).toBe(false); // dir pattern + file negation
    expect(isIgnored('dist/x.js', ['dist/', '!dist/keep.js'])).toBe(true);
  });

  it('does not match an unlisted path', () => {
    expect(isIgnored('src/cli.ts', patterns)).toBe(false);
  });

  it('returns false when there are no patterns', () => {
    expect(isIgnored('anything.ts', [])).toBe(false);
  });

  it('trailing slash ignores the whole tree (gitignore dir semantics)', () => {
    expect(isIgnored('dist/x.js', ['dist/'])).toBe(true);
    expect(isIgnored('dist/a/b.js', ['dist/'])).toBe(true);
    expect(isIgnored('src/dist/foo.ts', ['dist/'])).toBe(true);
    expect(isIgnored('src/x.js', ['dist/'])).toBe(false);
  });

  it('traverses hidden dirs under a glob (gitignore parity — dot:true)', () => {
    expect(isIgnored('playground/optimize-deps/.hidden-dir/foo.js', ['playground/**'])).toBe(true);
    expect(isIgnored('playground/.cache/foo.js', ['playground/**'])).toBe(true);
    expect(isIgnored('src/x.ts', ['playground/**'])).toBe(false);
  });
});
