import { parse as parseToml } from 'smol-toml';

export interface CellsConfig {
  maxPayloadTokens: number;
  layers: Record<number, string>; // optional legend: tier rank → label (output readability). Empty = show raw numbers.
  codeDirs: string[]; // directories scanned for code (default: src, test)
  codeExts: string[]; // extensions counted as code (default: .ts) — set per language
  moduleRoot?: string; // path prefix stripped from module names (e.g. "src" for Python src-layout: src/utils/schema.py → utils.schema)
  ignoreBlindExts: string[]; // extensions to silence the "no importer — crossings BLIND" warning for (e.g. a lone .c vendored file)
}

/**
 * Default payload ceiling (tokens). Grounded in effective-context research:
 * model quality degrades at an ABSOLUTE ~32k+ tokens (not proportional to the
 * nominal window). A cell's payload is one part of the model's working context
 * (task + reasoning + output take the rest), so 16k keeps total under the onset.
 * See `.scratch` grill notes / web research.
 */
export const DEFAULT_MAX_PAYLOAD_TOKENS = 16000;

/** Change-coupling analysis knobs (ADR 0002 — change-coupled cells). Fixed constants,
 *  dogfooded on real repos before they'd ever move to config.toml. One tunable spot. */
export const CHANGE_COUPLING = {
  /** Recent-commit window: last N commits touching any owned file. The current
   *  development focus, not ancient history — the axis of change is where change
   *  happens now. Shallow clones see min(N, depth). */
  window: 200,
  /** Jaccard |A∩B| / |A∪B| floor — of every ~3 commits touching either cell, >=1
   *  touches both. */
  jaccard: 0.3,
  /** Absolute co-change commit floor — kills small-sample noise on quiet repos. */
  minCoChanges: 5,
  /** A commit touching >30% of owned files is a mass refactor/format pass — it would
   *  dominate every pair's union and union Jaccard is meaningless; excluded. Exactly
   *  30% is NOT wide (matches the `> ratio` comparison). Absolute floor too: on a
   *  small repo (4 files) a 2-file commit is 50% but is NOT a reformat pass — the
   *  ratio only bites once the commit is ALSO larger than wideCommitMin files. */
  wideCommitRatio: 0.3,
  /** See wideCommitRatio — a commit smaller than this many owned files is never wide. */
  wideCommitMin: 10,
  /** Commits whose only owned files are these are dependency-bump noise — a lockfile
   *  co-changes with every unrelated change. Root-level + nested. */
  lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock', 'yarn.lock', 'go.sum'],
  /** Generated artifacts co-change with everything. Minimal list; .map deliberately
   *  skipped (source maps sit beside real sources in commits). */
  generated: ['.wasm', '.min.js'],
} as const;

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
      '# Max tokens per cell payload — the context-fit ceiling. Default: 16000; a STARTING',
      '# knob, not a target — big modules exceed it by design (size warns, never gates).',
      '# Edit here to raise/lower cell sizes.',
      'max-payload-tokens = 16000',
      '',
      '# Directories scanned for code (ownership census + import crossings).',
      `code-dirs = [${dirs}]`,
      '',
      '# Extensions counted as code. Add one per language: .ts .py .rs .go ...',
      `code-exts = [${exts}]`,
      '',
      '# Module root: path prefix stripped from module names for import resolution.',
      '# Python src-layout: set to "src" so src/utils/schema.py → utils.schema (matching `from utils.schema import ...`).',
      '# Leave unset if your code sits directly in code-dirs (no extra nesting).',
      '# module-root = "src"',
      '',
      '# Extensions to silence the "no importer — crossings BLIND" warning for',
      '# (e.g. a lone vendored .c file in a Rust repo).',
      '# ignore-blind-exts = [".c"]',
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
    'module-root'?: unknown;
    'ignore-blind-exts'?: unknown;
  };
  const maxPayloadTokens = raw['max-payload-tokens'];
  if (typeof maxPayloadTokens === 'number' && (!Number.isFinite(maxPayloadTokens) || maxPayloadTokens <= 0)) {
    throw new Error(`invalid config.toml: 'max-payload-tokens' must be a positive number (got ${maxPayloadTokens})`);
  }
  const layersRaw = raw.layers;
  const layers: Record<number, string> = {};
  if (layersRaw && typeof layersRaw === 'object' && !Array.isArray(layersRaw)) {
    for (const [k, v] of Object.entries(layersRaw as Record<string, unknown>)) {
      // TOML trap: a bare key written AFTER the `[layers]` header (e.g. `module-root = "src"`
      // appended at the file end) lands INSIDE the layers table, and smol-toml parses it as
      // a layer entry. Layer keys are always integers, so any other key is a misconfig —
      // name it instead of silently ignoring it (the value would otherwise vanish, and the
      // user would debug a config key that "doesn't work").
      if (!/^\d+$/.test(k)) {
        console.warn(`cells: config.toml [layers] has a non-numeric key "${k}" — a bare key after the [layers] header belongs to the layers table. Move it ABOVE the header (or fix the typo).`);
        continue;
      }
      const n = Number(k);
      if (Number.isInteger(n) && typeof v === 'string') layers[n] = v;
    }
  }
  const codeDirs = raw['code-dirs'];
  const codeExts = raw['code-exts'];
  const moduleRoot = raw['module-root'];
  const ignoreBlindExts = raw['ignore-blind-exts'];
  // Array keys are passed to path.join / extension matching — a non-string element (e.g.
  // `code-dirs = [123]`) would crash later with a bare path TypeError; reject at the parse
  // boundary with the field named. (Defaults apply when the key is absent.)
  const strArray = (v: unknown, field: string, dflt: string[]): string[] => {
    if (v === undefined) return dflt;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`invalid config.toml: '${field}' must be a string array`);
    return v as string[];
  };
  return {
    maxPayloadTokens: typeof maxPayloadTokens === 'number' ? maxPayloadTokens : DEFAULT_MAX_PAYLOAD_TOKENS,
    layers,
    codeDirs: strArray(codeDirs, 'code-dirs', ['src', 'test']),
    codeExts: strArray(codeExts, 'code-exts', ['.ts']),
    moduleRoot: typeof moduleRoot === 'string' ? moduleRoot : undefined,
    ignoreBlindExts: strArray(ignoreBlindExts, 'ignore-blind-exts', []),
  };
}
