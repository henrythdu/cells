import { describe, it, expect } from 'vitest';
import { parseOwnership, serializeOwnership, owningCell, type Ownership } from '../src/ownership.js';

describe('parseOwnership', () => {
  it('parses a cell→files ownership map', () => {
    // Fixture — independent source of truth.
    const toml = [
      '[parser]',
      'files = ["src/declaration.ts", "src/parser.ts"]',
      '',
      '[ownership]',
      'files = ["src/ownership.ts"]',
      '',
    ].join('\n');

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
