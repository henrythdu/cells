import { describe, it, expect } from 'vitest';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS, DEFAULT_CONFIG, buildConfig } from '../src/config.js';

const DEFAULT_DIRS = { codeDirs: ['src', 'test'], codeExts: ['.ts'] };

describe('parseConfig', () => {
  it('reads max-payload-tokens', () => {
    expect(parseConfig('max-payload-tokens = 8000\n')).toEqual({
      maxPayloadTokens: 8000,
      layers: {},
      ...DEFAULT_DIRS,
    });
  });

  it('falls back to defaults when empty', () => {
    expect(parseConfig('')).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: {},
      ...DEFAULT_DIRS,
    });
  });

  it('DEFAULT_CONFIG (the `cells init` template) round-trips to the defaults', () => {
    expect(parseConfig(DEFAULT_CONFIG)).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: {},
      ...DEFAULT_DIRS,
    });
  });

  it('default is 16000 (grounded in effective-context research, ~32k degradation onset)', () => {
    expect(DEFAULT_MAX_PAYLOAD_TOKENS).toBe(16000);
  });

  it('reads layers legend (rank → label)', () => {
    const toml = '[layers]\n0 = "detail"\n10 = "domain"\n';
    expect(parseConfig(toml)).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: { 0: 'detail', 10: 'domain' },
      ...DEFAULT_DIRS,
    });
  });

  it('reads code-dirs + code-exts (for non-TS repos)', () => {
    const toml = 'code-dirs = ["lib", "cmd"]\ncode-exts = [".go"]\n';
    expect(parseConfig(toml)).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: {},
      codeDirs: ['lib', 'cmd'],
      codeExts: ['.go'],
    });
  });

  it('reads module-root (Python src-layout)', () => {
    expect(parseConfig('module-root = "src"\n').moduleRoot).toBe('src');
  });

  it('module-root defaults to undefined when absent', () => {
    expect(parseConfig('').moduleRoot).toBeUndefined();
  });
});

describe('buildConfig', () => {
  it('writes detected code-exts + code-dirs into the template', () => {
    const py = buildConfig(['.py'], ['src', 'tests']);
    expect(parseConfig(py)).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: {},
      codeDirs: ['src', 'tests'],
      codeExts: ['.py'],
    });
  });

  it('round-trips for a Rust repo', () => {
    const rs = buildConfig(['.rs'], ['src']);
    expect(parseConfig(rs).codeExts).toEqual(['.rs']);
    expect(parseConfig(rs).codeDirs).toEqual(['src']);
  });

  it('TS defaults still round-trip (empty-repo fallback)', () => {
    expect(parseConfig(buildConfig(['.ts'], ['src', 'test']))).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: {},
      ...DEFAULT_DIRS,
    });
  });
});
