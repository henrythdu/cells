import { parse as parseToml } from 'smol-toml';

export interface CellsConfig {
  maxPayloadTokens: number;
  layers: Record<number, string>; // optional legend: tier rank → label (output readability). Empty = show raw numbers.
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
 * Default `.cells/config.toml` written by `cells init`. Filled with the defaults +
 * comments so the user sees what's configurable; every key is optional, so
 * deleting one reverts to its default (see `parseConfig`). Round-trips through
 * `parseConfig` to the defaults (verified in config.test.ts).
 */
export const DEFAULT_CONFIG = `# Cells configuration. Every key is optional — delete one to use its default.
# Run \`cells help\` for what each command does.

# Max tokens per cell payload (the context-fit ceiling). Default: 16000.
max-payload-tokens = 16000

# Directories scanned for code (ownership census + import crossings).
code-dirs = ["src", "test"]

# Extensions counted as code. Add one per language: .ts .py .rs .go ...
code-exts = [".ts"]

# Optional layer legend: tier rank -> label (0 = core). Shown in list/structure.
# Uncomment + edit to label your tiers; leave as-is to show raw numbers.
[layers]
# 0 = "core"
# 1 = "rule"
# 2 = "detail"
`;

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
  const layersRaw = raw.layers;
  const layers: Record<number, string> = {};
  if (layersRaw && typeof layersRaw === 'object' && !Array.isArray(layersRaw)) {
    for (const [k, v] of Object.entries(layersRaw as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isInteger(n) && typeof v === 'string') layers[n] = v;
    }
  }
  const codeDirs = raw['code-dirs'];
  const codeExts = raw['code-exts'];
  return {
    maxPayloadTokens:
      typeof maxPayloadTokens === 'number' ? maxPayloadTokens : DEFAULT_MAX_PAYLOAD_TOKENS,
    layers,
    codeDirs: Array.isArray(codeDirs) ? (codeDirs as string[]) : ['src', 'test'],
    codeExts: Array.isArray(codeExts) ? (codeExts as string[]) : ['.ts'],
  };
}
