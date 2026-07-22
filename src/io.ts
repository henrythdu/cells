import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { parseCell, type Cell } from './declaration.js';
import { parseOwnership, type Ownership } from './ownership.js';
import { assemblePayload } from './payload.js';
import type { ImportEdge } from './crossings.js';
import { parseIgnore, isIgnored } from './ignore.js';
import { parseConfig, DEFAULT_MAX_PAYLOAD_TOKENS, type CellsConfig } from './config.js';
import type { CellSize } from './view.js';

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
export function readFiles(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    try {
      out[p] = readFileSync(p, 'utf8');
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
export function listCodeFiles(): string[] {
  const { codeDirs, codeExts } = loadConfig();
  const all = codeDirs.flatMap((dir) => listFiles(dir, codeExts));
  const ignorePath = join(CELLS_DIR, 'ignore');
  if (!existsSync(ignorePath)) return all;
  const patterns = parseIgnore(readFileSync(ignorePath, 'utf8'));
  return all.filter((f) => !isIgnored(f, patterns));
}

/** Collect raw import edges (file→file) from src/ + test/ via dependency-cruiser. */
export async function collectImportEdges(): Promise<ImportEdge[]> {
  const { output } = await cruise(['src/', 'test/'], {
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  });
  const result = output as ICruiseResult;
  const norm = (p: string): string => p.replace(/^\.\//, '');
  const edges: ImportEdge[] = [];
  for (const mod of result.modules ?? []) {
    for (const dep of mod.dependencies ?? []) {
      if (dep.couldNotResolve || dep.coreModule) continue; // external / node built-in
      if (!dep.resolved) continue;
      edges.push({ fromFile: norm(mod.source), toFile: norm(dep.resolved), import: dep.module });
    }
  }
  return edges;
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
