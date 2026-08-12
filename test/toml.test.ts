import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { tomlArray, tomlString } from '../src/toml.js';

describe('toml primitives', () => {
  it('tomlString quotes a plain string', () => {
    expect(tomlString('hello')).toBe('"hello"');
  });

  it('tomlString escapes backslash and double-quote', () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('tomlArray formats a string array inline', () => {
    expect(tomlArray(['a', 'b'])).toBe('["a", "b"]');
  });

  it('tomlArray is empty for []', () => {
    expect(tomlArray([])).toBe('[]');
  });

  it('tomlArray escapes element special chars', () => {
    expect(tomlArray(['a"b'])).toBe('["a\\"b"]');
  });

  it('tomlString escapes control characters (\n \r \t and byte controls)', () => {
    expect(tomlString('a\nb\tc\rd\u0001')).toBe('"a\\nb\\tc\\rd\\u0001"');
  });

  it('control-escaped output parses back to the original string (round-trip)', () => {
    const original = 'a\nb"c\\d\t\u0002';
    const parsed = parse(`x = ${tomlString(original)}`) as { x: string };
    expect(parsed.x).toBe(original);
  });
});
