import { describe, it, expect } from 'vitest';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS } from '../src/config.js';

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
});
