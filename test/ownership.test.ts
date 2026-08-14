import { describe, expect, it } from 'vitest';
import { type Ownership, owningCell, parseOwnership, serializeOwnership } from '../src/ownership.js';

describe('parseOwnership', () => {
  it('parses a cell→files ownership map', () => {
    // Fixture — independent source of truth.
    const toml = ['[parser]', 'files = ["src/declaration.ts", "src/parser.ts"]', '', '[ownership]', 'files = ["src/ownership.ts"]', ''].join('\n');

    expect(parseOwnership(toml)).toEqual({
      parser: ['src/declaration.ts', 'src/parser.ts'],
      ownership: ['src/ownership.ts'],
    });
  });
});

describe('serializeOwnership', () => {
  it('round-trips through parseOwnership', () => {
    const ownership: Ownership = {
      parser: ['src/parser.ts', 'test/parser.test.ts'],
      util: ['src/util.ts'],
    };
    expect(parseOwnership(serializeOwnership(ownership))).toEqual(ownership);
  });

  it('serializes an empty map to an empty string', () => {
    expect(serializeOwnership({})).toBe('');
  });

  it('serializes deterministically — sorted cells, sorted files, one per line (merge-friendly)', () => {
    const out = serializeOwnership({ zebra: ['b/z2.ts', 'b/z1.ts'], alpha: ['src/a.ts'], empty: [] });
    expect(out).toBe('[alpha]\nfiles = [\n  "src/a.ts",\n]\n\n[empty]\nfiles = []\n\n[zebra]\nfiles = [\n  "b/z1.ts",\n  "b/z2.ts",\n]\n');
    // insertion order and file order in the input must not leak into the output
    expect(serializeOwnership({ zebra: ['b/z2.ts', 'b/z1.ts'], alpha: ['src/a.ts'] })).toBe(
      serializeOwnership({ alpha: ['src/a.ts'], zebra: ['b/z1.ts', 'b/z2.ts'] }),
    );
  });

  it('a non-bare cell name is quoted — the round-trip keeps the files (no nested table)', () => {
    const o: Ownership = { 'a.b': ['src/x.ts'] };
    expect(parseOwnership(serializeOwnership(o))).toEqual(o);
  });
});

describe('owningCell', () => {
  it('returns the cell that owns a file', () => {
    const ownership: Ownership = { parser: ['src/parser.ts'], util: ['src/util.ts'] };
    expect(owningCell(ownership, 'src/util.ts')).toBe('util');
  });

  it('returns undefined for an unowned file', () => {
    const ownership: Ownership = { parser: ['src/parser.ts'] };
    expect(owningCell(ownership, 'src/orphan.ts')).toBeUndefined();
  });
});
