import { describe, expect, it, vi } from 'vitest';
import { buildConfig, DEFAULT_CONFIG, DEFAULT_MAX_PAYLOAD_TOKENS, parseConfig } from '../src/config.js';

const DEFAULT_DIRS = { codeDirs: ['src', 'test'], codeExts: ['.ts'], ignoreBlindExts: [] };

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

  it('warns when a bare key lands inside [layers] (the module-root trap) instead of silently ignoring it', () => {
    // `module-root = "src"` appended AFTER the `[layers]` header parses as a layer entry.
    // It must not silently vanish — name the trap.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = parseConfig('[layers]\n0 = "core"\nmodule-root = "src"\n');
      expect(cfg.layers).toEqual({ 0: 'core' });
      expect(cfg.moduleRoot).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('module-root'));
    } finally {
      warn.mockRestore();
    }
  });

  it('reads code-dirs + code-exts (for non-TS repos)', () => {
    const toml = 'code-dirs = ["lib", "cmd"]\ncode-exts = [".go"]\n';
    expect(parseConfig(toml)).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: {},
      codeDirs: ['lib', 'cmd'],
      codeExts: ['.go'],
      ignoreBlindExts: [],
    });
  });

  it('reads module-root (Python src-layout)', () => {
    expect(parseConfig('module-root = "src"\n').moduleRoot).toBe('src');
  });

  it('reads ignore-blind-exts (per-ext blind-warning silence)', () => {
    expect(parseConfig('ignore-blind-exts = [".c", ".h"]\n').ignoreBlindExts).toEqual(['.c', '.h']);
    expect(parseConfig('').ignoreBlindExts).toEqual([]);
  });

  it('module-root defaults to undefined when absent', () => {
    expect(parseConfig('').moduleRoot).toBeUndefined();
  });

  it('rejects non-string elements in array keys (the path-join crash class)', () => {
    expect(() => parseConfig('code-dirs = [123]')).toThrow(/code-dirs.*string array/);
    expect(() => parseConfig('code-exts = [".ts", 4]')).toThrow(/code-exts.*string array/);
    expect(() => parseConfig('ignore-blind-exts = [true]')).toThrow(/ignore-blind-exts.*string array/);
  });

  it('rejects a non-positive max-payload-tokens (would crash the size bar)', () => {
    expect(() => parseConfig('max-payload-tokens = 0')).toThrow(/max-payload-tokens/);
    expect(() => parseConfig('max-payload-tokens = -10')).toThrow(/max-payload-tokens/);
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
      ignoreBlindExts: [],
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
