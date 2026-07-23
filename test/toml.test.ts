import { describe, it, expect } from 'vitest';
import { tomlString, tomlArray } from '../src/toml.js';

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
});
