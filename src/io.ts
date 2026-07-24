import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseCell, type Cell } from './declaration.js';
import { parseOwnership, type Ownership } from './ownership.js';
import { assemblePayload, type CellSize } from './payload.js';
import { parseIgnore, isIgnored } from './ignore.js';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS, type CellsConfig } from './config.js';

export const CELLS_DIR = '.cells';

/** Guard: ensure this is a Cells project (`.cells/` exists). Friendly exit if not. */
export function requireCells(): void {
  if (!existsSync(CELLS_DIR)) {
    console.error(`not a Cells project — no \`${CELLS_DIR}/\` here. Run \`cells init\` first.`);
    process.exit(1);
  }
}

/** Load every `.cell.toml` declaration in `.cells/`, keyed by cell name. */
export function loadDeclarations(): Record<string, Cell> {
  const decls: Record<string, Cell> = {};
  for (const file of readdirSync(CELLS_DIR)) {
    if (!file.endsWith('.cell.toml')) continue;
    const cell = parseCell(readFileSync(join(CELLS_DIR, file), 'utf8'));
    decls[cell.name] = cell;
  }
  return decls;
}

/** Load the ownership map from `.cells/ownership.toml`. */
export function loadOwnership(): Ownership {
  return parseOwnership(readFileSync(join(CELLS_DIR, 'ownership.toml'), 'utf8'));
}

/** Load `.cells/config.toml` (optional — missing file → defaults). */
export function loadConfig(): CellsConfig {
  const path = join(CELLS_DIR, 'config.toml');
  if (!existsSync(path)) return { maxPayloadTokens: DEFAULT_MAX_PAYLOAD_TOKENS, layers: [], codeDirs: ['src', 'test'], codeExts: ['.ts'] };
  return parseConfig(readFileSync(path, 'utf8'));
}

/** Read a list of files into a {path→content} map (missing files skipped — validate flags them). */
/** Read files into a {path→content} map (missing files skipped — validate flags them).
 *  `baseDir` lets callers read from elsewhere (e.g. an extracted HEAD tree for `--diff`). */
export function readFiles(paths: string[], baseDir = '.'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    try {
      out[p] = readFileSync(join(baseDir, p), 'utf8');
    } catch {
      // missing — validate flags as dangling
    }
  }
  return out;
}

/** Recursively list files under a directory whose extension is in `exts` (relative paths). */
export function listFiles(dir: string, exts: string[]): string[] {
  if (!existsSync(dir)) return []; // a repo may lack a configured dir yet
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(path);
  }
  return out;
}

/** All code files on disk (per config `code-dirs`/`code-exts`), excluding `.cells/ignore` matches. */
/** All code files on disk (per config `code-dirs`/`code-exts`), excluding `.cells/ignore` matches.
 *  `baseDir` reads code from elsewhere (e.g. an extracted HEAD tree); paths stay repo-relative
 *  so ownership still resolves. `.cells/` (config/ownership/ignore) is always the working repo's. */
export function listCodeFiles(baseDir = '.'): string[] {
  const { codeDirs, codeExts } = loadConfig();
  const all = codeDirs.flatMap((dir) => listFiles(join(baseDir, dir), codeExts).map((f) => relative(baseDir, f)));
  const ignorePath = join(CELLS_DIR, 'ignore');
  if (!existsSync(ignorePath)) return all;
  const patterns = parseIgnore(readFileSync(ignorePath, 'utf8'));
  return all.filter((f) => !isIgnored(f, patterns));
}


/** Resolve a cell's neighbor declarations (for payload assembly). */
export function neighborsOf(cell: Cell, declarations: Record<string, Cell>): Cell[] {
  return cell.requires.map((r) => declarations[r]).filter((c): c is Cell => Boolean(c));
}

/** Assemble a cell's payload and measure it — the context-fit metric (what the model consumes). */
export function computePayloadSize(cell: Cell, ownedFiles: string[], neighbors: Cell[]): CellSize {
  const fileContents = readFiles(ownedFiles);
  const chars = assemblePayload(cell, ownedFiles, fileContents, neighbors).length;
  return { files: ownedFiles.length, chars, tokens: Math.ceil(chars / 4) };
}

// --- git (for `crossings --diff`: derive crossings at HEAD vs the working tree) ---

/** Is the working tree inside a git repo? */
export function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Extract the HEAD tree (tracked files only) into `dir`. False if there's no HEAD yet
 *  (fresh repo) or git/tar is unavailable — callers degrade gracefully. */
export function extractHeadTree(dir: string): boolean {
  try {
    execSync(`git archive HEAD | tar -x -C "${dir}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` against a throwaway copy of the HEAD tree; always clean up.
 *  Returns null if HEAD can't be read (no commits / git broken) so callers can degrade. */
export async function withHeadTree<T>(fn: (headDir: string) => Promise<T> | T): Promise<T | null> {
  const dir = mkdtempSync(join(tmpdir(), 'cells-head-'));
  try {
    if (!extractHeadTree(dir)) return null;
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
