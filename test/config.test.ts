import { describe, it, expect } from 'vitest';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS } from '../src/config.js';

describe('parseConfig', () => {
  it('reads max-payload-tokens', () => {
    expect(parseConfig('max-payload-tokens = 8000\n')).toEqual({ maxPayloadTokens: 8000 });
  });

  it('falls back to the default when the field is absent', () => {
    expect(parseConfig('')).toEqual({ maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS });
  });

  it('default is 16000 (grounded in effective-context research, ~32k degradation onset)', () => {
    expect(DEFAULT_MAX_PAYLOAD_TOKENS).toBe(16000);
  });
});
