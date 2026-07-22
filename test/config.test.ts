import { describe, it, expect } from 'vitest';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS } from '../src/config.js';

describe('parseConfig', () => {
  it('reads max-payload-tokens', () => {
    expect(parseConfig('max-payload-tokens = 8000\n')).toEqual({ maxPayloadTokens: 8000, layers: [] });
  });

  it('falls back to defaults when empty', () => {
    expect(parseConfig('')).toEqual({ maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS, layers: [] });
  });

  it('default is 16000 (grounded in effective-context research, ~32k degradation onset)', () => {
    expect(DEFAULT_MAX_PAYLOAD_TOKENS).toBe(16000);
  });

  it('reads layers (ordered, index 0 = lowest)', () => {
    const toml = 'layers = ["infrastructure", "application", "domain"]\n';
    expect(parseConfig(toml)).toEqual({
      maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS,
      layers: ['infrastructure', 'application', 'domain'],
    });
  });
});
