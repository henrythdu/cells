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

/** Default `.cells/config.toml` written by `cells init` when no code is detected (empty repo).
 *  Filled with TS defaults + comments so every key is visible; deleting one reverts to its
 *  default (see `parseConfig`). Round-trips through `parseConfig` (verified in config.test.ts). */
export const DEFAULT_CONFIG = buildConfig(['.ts'], ['src', 'test']);

/** Build a `.cells/config.toml` template with detected `code-exts`/`code-dirs` so a Python/Rust
 *  repo doesn't ship TypeScript-only defaults. Every key is still optional. Pure. */
export function buildConfig(codeExts: string[], codeDirs: string[]): string {
  const exts = codeExts.map((e) => `"${e}"`).join(', ');
  const dirs = codeDirs.map((d) => `"${d}"`).join(', ');
  return (
    [
      '# Cells configuration. Every key is optional — delete one to use its default.',
      '# Run `cells help` for what each command does.',
      '',
      '# Max tokens per cell payload (the context-fit ceiling). Default: 16000.',
      'max-payload-tokens = 16000',
      '',
      '# Directories scanned for code (ownership census + import crossings).',
      `code-dirs = [${dirs}]`,
      '',
      '# Extensions counted as code. Add one per language: .ts .py .rs .go ...',
      `code-exts = [${exts}]`,
      '',
      '# Optional layer legend: tier rank -> label (0 = core). Shown in list/structure.',
      '# Uncomment + edit to label your tiers; leave as-is to show raw numbers.',
      '[layers]',
      '# 0 = "core"',
      '# 1 = "rule"',
      '# 2 = "detail"',
      '',
    ].join('\n') + '\n'
  );
}

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
    maxPayloadTokens: typeof maxPayloadTokens === 'number' ? maxPayloadTokens : DEFAULT_MAX_PAYLOAD_TOKENS,
    layers,
    codeDirs: Array.isArray(codeDirs) ? (codeDirs as string[]) : ['src', 'test'],
    codeExts: Array.isArray(codeExts) ? (codeExts as string[]) : ['.ts'],
  };
}
