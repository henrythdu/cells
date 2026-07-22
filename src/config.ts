import { parse as parseToml } from 'smol-toml';

export interface CellsConfig {
  maxPayloadTokens: number;
  layers: string[]; // ordered layer names, index 0 = lowest (Clean-Arch direction policy)
  codeDirs: string[]; // directories scanned for code (default: src, test)
  codeExts: string[]; // extensions counted as code (default: .ts) — set per language
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
 * TOML keys are kebab-case where multi-word.
 */
export function parseConfig(content: string): CellsConfig {
  const raw = parseToml(content) as {
    'max-payload-tokens'?: unknown;
    layers?: unknown;
    'code-dirs'?: unknown;
    'code-exts'?: unknown;
  };
  const maxPayloadTokens = raw['max-payload-tokens'];
  const layers = raw.layers;
  const codeDirs = raw['code-dirs'];
  const codeExts = raw['code-exts'];
  return {
    maxPayloadTokens:
      typeof maxPayloadTokens === 'number' ? maxPayloadTokens : DEFAULT_MAX_PAYLOAD_TOKENS,
    layers: Array.isArray(layers) ? (layers as string[]) : [],
    codeDirs: Array.isArray(codeDirs) ? (codeDirs as string[]) : ['src', 'test'],
    codeExts: Array.isArray(codeExts) ? (codeExts as string[]) : ['.ts'],
  };
}
