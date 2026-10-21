import { parse as parseToml } from 'smol-toml';

export interface CellsConfig {
  maxPayloadTokens: number;
  layers: Record<number, string>; // An optional legend: tier rank to label, for readable output. Empty shows the raw numbers.
  codeDirs: string[]; // The directories that the system scans for code. Default: src, test.
  codeExts: string[]; // The extensions that the system counts as code. Default: .ts. Set them for your language.
  moduleRoot?: string; // The path prefix that the system removes from module names. Example: "src" for the Python src layout, so src/utils/schema.py becomes utils.schema.
  ignoreBlindExts: string[]; // The extensions for which the system does not write the "no importer, crossings BLIND" warning. Example: a single vendored .c file in a Rust repository.
  skipDirs?: string[]; // The directory names that the census never walks. The default is the built-in SKIP_DIRS list. A value REPLACES that list: to make a real internal or build package adoptable, set skip-dirs = [].
}

/**
 * The default payload ceiling in tokens.
 *
 * The value comes from effective-context research. Model quality degrades at an absolute
 * limit of about 32000 tokens, and the limit is not proportional to the nominal window. A
 * cell payload is one part of the working context of a model: the task, the reasoning, and
 * the output take the rest. Therefore 16000 keeps the total below the onset.
 */
export const DEFAULT_MAX_PAYLOAD_TOKENS = 16000;

/**
 * The settings for the change-coupling analysis (ADR 0002: change-coupled cells). These
 * values are fixed constants. The project tested them on real repositories before they
 * could move to config.toml. This is the one place to tune them.
 */
export const CHANGE_COUPLING = {
  /**
   * The number of recent commits that touch an owned file. The analysis looks at the
   * current development focus and not at old history, because the axis of change is where
   * changes happen now. A shallow clone sees min(N, depth) commits.
   */
  window: 200,
  /** The floor for the Jaccard value: A intersect B, divided by A union B. Of every 3 commits that touch either cell, at least 1 touches both cells. */
  jaccard: 0.3,
  /** The absolute floor for the number of co-change commits. This value removes small-sample noise in a quiet repository. */
  minCoChanges: 5,
  /**
   * A commit that touches more than 30% of the owned files is a mass refactor or a format
   * pass. Such a commit would dominate the union of every pair, and the union Jaccard value
   * would be meaningless. Therefore the analysis excludes it.
   *
   * Exactly 30% is not wide, which matches the `> ratio` comparison. The absolute floor also
   * applies. In a small repository with 4 files, a commit of 2 files is 50% but is not a
   * reformat pass. The ratio applies only when the commit is also larger than
   * `wideCommitMin` files.
   */
  wideCommitRatio: 0.3,
  /** See `wideCommitRatio`. A commit with fewer than this number of owned files is never wide. */
  wideCommitMin: 10,
  /** A commit whose only owned files are these files is a dependency bump. A lockfile co-changes with every unrelated change. The list covers root-level and nested files. */
  lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock', 'yarn.lock', 'go.sum'],
  /** Generated artifacts co-change with everything. The list is minimal. `.map` is deliberately absent, because a source map sits beside the real source in a commit. */
  generated: ['.wasm', '.min.js'],
} as const;

/**
 * The content that `cells init` writes when it detects no code (an empty repository). Init
 * calls `buildConfig` with the detected values, which equal these TypeScript defaults. This
 * constant is the round-trip pin for the template: it contains the TypeScript defaults and
 * the comments, so every key is visible. When a key is deleted, its default applies (see
 * `parseConfig`). `config.test.ts` verifies the round-trip through `parseConfig`.
 */
export const DEFAULT_CONFIG = buildConfig(['.ts'], ['src', 'test']);

/**
 * Build the text of a `.cells/config.toml` template with the detected `code-exts` and
 * `code-dirs`. A Python or a Rust repository thus does not get TypeScript-only defaults.
 * Every key is still optional. Pure.
 */
export function buildConfig(codeExts: string[], codeDirs: string[]): string {
  const exts = codeExts.map((e) => `"${e}"`).join(', ');
  const dirs = codeDirs.map((d) => `"${d}"`).join(', ');
  return `${[
    '# Cells configuration. Every key is optional — delete one to use its default.',
    '# Run `cells help` for what each command does.',
    '',
    '# Max tokens per cell payload — the context-fit ceiling. A STARTING',
    `# (default: ${DEFAULT_MAX_PAYLOAD_TOKENS}) knob, not a target — big modules exceed it by design (size warns, never gates).`,
    '# Edit here to raise/lower cell sizes.',
    `max-payload-tokens = ${DEFAULT_MAX_PAYLOAD_TOKENS}`,
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
    '# Dir names the census never walks (deps/build/tooling): node_modules, dist, build,',
    '# target, .git, .cells, vendor, .venv, __pycache__, ... Setting this REPLACES the',
    '# defaults — a real internal/build Go package becomes adoptable via:',
    '# skip-dirs = []',
    '',
    '# Optional layer legend: tier rank -> label (0 = core). Shown in list/structure.',
    '# Uncomment + edit to label your tiers; leave as-is to show raw numbers.',
    '[layers]',
    '# 0 = "core"',
    '# 1 = "rule"',
    '# 2 = "detail"',
    '',
  ].join('\n')}\n`;
}

/**
 * Parse `.cells/config.toml`. A missing value or an empty file gives the defaults. Pure. A
 * multi-word key uses kebab-case.
 */
export function parseConfig(content: string): CellsConfig {
  // A UTF-8 byte-order mark is invisible, and smol-toml reads it as part of the first key.
  // Strip it here, so every reader accepts a file that an editor stamped with one.
  const raw = parseToml(content.replace(/^\uFEFF/, '')) as {
    'max-payload-tokens'?: unknown;
    layers?: unknown;
    'code-dirs'?: unknown;
    'code-exts'?: unknown;
    'module-root'?: unknown;
    'ignore-blind-exts'?: unknown;
    'skip-dirs'?: unknown;
  };
  const maxPayloadTokens = raw['max-payload-tokens'];
  // A value of the wrong type must throw and must not become the default silently. For
  // example, the quoted typo `= "8000"` would run at 16000, and the user would debug a
  // ceiling that "does not work". An absent value uses the default.
  if (maxPayloadTokens !== undefined && typeof maxPayloadTokens !== 'number') {
    throw new Error(`invalid config.toml: 'max-payload-tokens' must be a positive number (got ${typeof maxPayloadTokens})`);
  }
  if (typeof maxPayloadTokens === 'number' && (!Number.isFinite(maxPayloadTokens) || maxPayloadTokens <= 0)) {
    throw new Error(`invalid config.toml: 'max-payload-tokens' must be a positive number (got ${maxPayloadTokens})`);
  }
  const layersRaw = raw.layers;
  const layers: Record<number, string> = {};
  if (layersRaw && typeof layersRaw === 'object' && !Array.isArray(layersRaw)) {
    for (const [k, v] of Object.entries(layersRaw as Record<string, unknown>)) {
      // TOML trap: a bare key after the `[layers]` header (for example, `module-root =
      // "src"` appended at the end of the file) belongs to the layers table, and smol-toml
      // parses it as a layer entry. A layer key is always an integer, so any other key is a
      // configuration error. Name the key here and do not ignore it silently, because the
      // value would otherwise disappear and the user would debug a key that "does not work".
      if (!/^\d+$/.test(k)) {
        console.warn(`cells: config.toml [layers] has a non-numeric key "${k}" — a bare key after the [layers] header belongs to the layers table. Move it ABOVE the header (or fix the typo).`);
        continue;
      }
      const n = Number(k);
      if (Number.isInteger(n) && typeof v === 'string') layers[n] = v;
    }
  } else if (layersRaw !== undefined) {
    throw new Error(`invalid config.toml: 'layers' must be a table of layer number → name (got ${Array.isArray(layersRaw) ? 'an array' : typeof layersRaw})`);
  }
  const codeDirs = raw['code-dirs'];
  const codeExts = raw['code-exts'];
  const moduleRoot = raw['module-root'];
  if (moduleRoot !== undefined && typeof moduleRoot !== 'string') {
    throw new Error(`invalid config.toml: 'module-root' must be a string (got ${typeof moduleRoot})`);
  }
  const ignoreBlindExts = raw['ignore-blind-exts'];
  const skipDirs = raw['skip-dirs'];
  // Array keys go to `path.join` and to extension matching. A non-string element (for
  // example, `code-dirs = [123]`) would fail later with a bare path TypeError. Reject it at
  // the parse boundary and name the field. An absent key uses the default.
  const strArray = (v: unknown, field: string, dflt: string[]): string[] => {
    if (v === undefined) return dflt;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`invalid config.toml: '${field}' must be a string array`);
    return v as string[];
  };
  // An extension matches by suffix, so a value without the dot (`"ts"`) also matches a file
  // that merely ends in those letters, and an empty value matches every file. Both change the
  // census without a warning. Require the dot form here, which is also the form that
  // `extname()` returns and that the importers declare.
  const extArray = (v: unknown, field: string, dflt: string[]): string[] =>
    strArray(v, field, dflt).map((raw) => {
      const ext = raw.trim();
      if (ext === '' || ext === '.') throw new Error(`invalid config.toml: '${field}' has an empty extension — write it as ".ts"`);
      return ext.startsWith('.') ? ext : `.${ext}`;
    });
  return {
    maxPayloadTokens: maxPayloadTokens ?? DEFAULT_MAX_PAYLOAD_TOKENS,
    layers,
    codeDirs: strArray(codeDirs, 'code-dirs', ['src', 'test']),
    codeExts: extArray(codeExts, 'code-exts', ['.ts']),
    moduleRoot,
    ignoreBlindExts: extArray(ignoreBlindExts, 'ignore-blind-exts', []),
    skipDirs: skipDirs === undefined ? undefined : strArray(skipDirs, 'skip-dirs', []),
  };
}
