import { parse as parseToml } from 'smol-toml';

export interface CellsConfig {
  maxPayloadTokens: number;
}

/**
 * Default payload ceiling (tokens). Grounded in effective-context research:
 * model quality degrades at an ABSOLUTE ~32k+ tokens (not proportional to the
 * nominal window). A cell's payload is one part of the model's working context
 * (task + reasoning + output take the rest), so 16k keeps total under the onset.
 * See `.scratch` grill notes / web research.
 */
export const DEFAULT_MAX_PAYLOAD_TOKENS = 16000;

/**
 * Parse `.cells/config.toml`. Missing/empty → defaults. Pure.
 * TOML key is kebab-case (`max-payload-tokens`).
 */
export function parseConfig(content: string): CellsConfig {
  const raw = parseToml(content) as { 'max-payload-tokens'?: unknown };
  const maxPayloadTokens = raw['max-payload-tokens'];
  return {
    maxPayloadTokens:
      typeof maxPayloadTokens === 'number' ? maxPayloadTokens : DEFAULT_MAX_PAYLOAD_TOKENS,
  };
}
