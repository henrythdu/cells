import { describe, it, expect } from 'vitest';
import { parseOwnership, serializeOwnership, type Ownership } from '../src/ownership.js';

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
