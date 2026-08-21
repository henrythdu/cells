/** The cell edit seam — store-coordinated mutation of one cell: comment-preserving
 *  declaration rewrite (text surgery, serializeCell fallback), ownership move, requires
 *  rewrite in dependents. Refusals throw the CLI's error message (main().catch prints
 *  them with the `cells: ` prefix and exits 1 — the exact stderr the CLI tests pin);
 *  success returns an outcome summary the `cmd*` printing adapters in mutate.ts render.
 *  The decl-centric trio only: assign/unassign keep their own seam (assign.ts — they
 *  move files, not cells). */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validCellName } from './assign.js';
import { checkLeakage } from './crossings.js';
import { type Cell, editCellDataRequires, editCellName, editCellRequires, serializeCell } from './declaration.js';
import { CELLS_DIR, loadDeclarations, loadOwnership, writeOwnership } from './io.js';
import { loadCrossings } from './pipeline.js';

/** Rewrite a declaration file with comment-preserving text surgery; the parsed+serialized
 *  declaration is the fallback when the file can't be read as text (identical policy in
 *  every edit path — the dance was copy-pasted across commands before the seam). Read and
 *  write paths differ for rename: the edited text of the OLD declaration lands at the NEW
 *  path; the caller then removes the old file (new-first ordering = atomicity). */
function editDeclFile(readPath: string, writePath: string, decl: Cell, edit: (text: string) => string): void {
  let content: string;
  try {
    content = edit(readFileSync(readPath, 'utf8'));
  } catch {
    // Never silent: the fallback discards whatever author comments the file carried —
    // the tool's promise is that authored membranes survive its edits.
    console.error(`warning: comment-preserving edit of ${basename(readPath)} failed — rewrote it from the parsed declaration (author comments, if any, are lost)`);
    content = serializeCell(decl);
  }
  writeFileSync(writePath, content);
}

/** Rename a cell: its declaration file (atomic — write new first, delete old), its
 *  ownership entry, and every requires reference in other cells' declarations.
 *  Throws on: invalid names, missing source cell, existing target cell, or an
 *  ownership-only [newName] entry that the move would clobber. Both names are a trust
 *  boundary — they become filenames under .cells/; a `..`-laden name would move a file
 *  outside the store (validated before any path is constructed). */
export function renameCell(oldName: string, newName: string): { ownedCount: number; requiresUpdated: number } {
  if (!validCellName(oldName) || !validCellName(newName)) {
    throw new Error(`invalid cell name "${oldName}" → "${newName}" — use only letters, numbers, dashes, underscores.`);
  }
  if (!existsSync(join(CELLS_DIR, `${oldName}.cell.toml`))) {
    throw new Error(`no cell named "${oldName}"`);
  }
  if (existsSync(join(CELLS_DIR, `${newName}.cell.toml`))) {
    throw new Error(`"${newName}" already exists — can't overwrite`);
  }
  const decls = loadDeclarations();
  const oldDecl = decls[oldName];
  const ownership = loadOwnership();
  // An ownership-only [newName] entry (no declaration) would be silently CLOBBERED by
  // the move — its files vanish from the partition. Check BEFORE any write; the store is
  // already odd (undeclared cell), so name it instead of destroying data.
  if (ownership[newName] !== undefined && !decls[newName]) {
    throw new Error(`ownership.toml already has a [${newName}] entry with no cell declaration — rename would overwrite it and orphan its files. Fix .cells/ownership.toml first.`);
  }

  // Atomicity: write the NEW declaration BEFORE removing the old file. The reverse order
  // leaves `new.cell.toml` declaring `name = "old"` on a write failure — loadDeclarations
  // throws on the mismatch and every command dies until hand-fix.
  const newPath = join(CELLS_DIR, `${newName}.cell.toml`);
  const oldPath = join(CELLS_DIR, `${oldName}.cell.toml`);
  if (oldDecl) {
    editDeclFile(oldPath, newPath, { ...oldDecl, name: newName }, (text) => editCellName(text, newName));
    rmSync(oldPath);
  } else {
    renameSync(oldPath, newPath); // declaration-less store entry — nothing to rewrite
  }

  const ownedCount = ownership[oldName]?.length ?? 0;
  if (ownership[oldName]) {
    ownership[newName] = ownership[oldName];
    delete ownership[oldName];
    writeOwnership(ownership);
  }

  let requiresUpdated = 0;
  for (const [name, decl] of Object.entries(decls)) {
    if (name === oldName) continue;
    const codeRefs = decl.requires.includes(oldName);
    const dataRefs = decl.dataRequires?.includes(oldName) ?? false;
    if (!codeRefs && !dataRefs) continue;
    const updated: Cell = {
      ...decl,
      requires: decl.requires.map((r) => (r === oldName ? newName : r)),
      dataRequires: decl.dataRequires?.map((r) => (r === oldName ? newName : r)),
    };
    // Both keys' text surgery (each is a no-op when its line is absent)
    editDeclFile(join(CELLS_DIR, `${name}.cell.toml`), join(CELLS_DIR, `${name}.cell.toml`), updated, (text) => editCellRequires(editCellDataRequires(text, { rename: [oldName, newName] }), { rename: [oldName, newName] }));
    requiresUpdated++;
  }
  return { ownedCount, requiresUpdated };
}

/** Remove a cell. Without --force, refuses when the cell owns files or is required by
 *  others (state must be resolved first); with --force the owned files orphan (→
 *  unowned) and dependents' requires references are stripped. Returns the outcome. */
export function removeCell(name: string, force: boolean): { ownedCount: number; dependents: string[] } {
  // Trust boundary: the name becomes a filename under .cells/ — a `..`-laden name would
  // delete a file outside the store (validated before any path is constructed).
  if (!validCellName(name)) {
    throw new Error(`invalid cell name "${name}" — use only letters, numbers, dashes, underscores.`);
  }
  const declPath = join(CELLS_DIR, `${name}.cell.toml`);
  if (!existsSync(declPath)) {
    throw new Error(`no cell named "${name}"`);
  }

  const ownership = loadOwnership();
  const ownedFiles = ownership[name] ?? [];
  const decls = loadDeclarations();
  // Dependents via EITHER key — a data-requires ref dangles exactly like a requires ref.
  const dependents = Object.values(decls)
    .filter((d) => d.name !== name && (d.requires.includes(name) || (d.dataRequires?.includes(name) ?? false)))
    .map((d) => d.name);

  if (!force && (ownedFiles.length > 0 || dependents.length > 0)) {
    if (ownedFiles.length > 0) throw new Error(`"${name}" owns ${ownedFiles.length} file(s) — reassign them (cells assign), or use --force to orphan them (→ unowned)`);
    throw new Error(`"${name}" is required by ${dependents.join(', ')} — update their requires/data-requires, or use --force to strip the references`);
  }

  rmSync(declPath);
  if (ownedFiles.length > 0 || ownership[name] !== undefined) {
    delete ownership[name];
    writeOwnership(ownership);
  }

  for (const dep of dependents) {
    const decl = decls[dep];
    const updated: Cell = { ...decl, requires: decl.requires.filter((r) => r !== name), dataRequires: decl.dataRequires?.filter((r) => r !== name) };
    editDeclFile(join(CELLS_DIR, `${dep}.cell.toml`), join(CELLS_DIR, `${dep}.cell.toml`), updated, (text) => editCellRequires(editCellDataRequires(text, { remove: [name] }), { remove: [name] }));
  }
  return { ownedCount: ownedFiles.length, dependents };
}

/** The stale-requires analysis (the listing both the dry run and --apply print):
 *  requires entries with no matching import, grouped by cell. */
export async function findStaleRequires(): Promise<Map<string, string[]>> {
  const ownership = loadOwnership();
  const { crossings } = await loadCrossings(ownership, false);
  const declarations = loadDeclarations();
  const byCell = new Map<string, string[]>();
  for (const l of checkLeakage(crossings, declarations)) {
    if (l.kind !== 'stale') continue;
    const list = byCell.get(l.fromCell) ?? [];
    list.push(l.toCell);
    byCell.set(l.fromCell, list);
  }
  return byCell;
}

/** Apply a stale-requires removal: strip the dead entries from each cell's declaration
 *  (comment-preserving). */
export function applyStalePrune(byCell: Map<string, string[]>): void {
  const declarations = loadDeclarations();
  for (const [cellName, reqs] of byCell) {
    const decl = declarations[cellName];
    const updated: Cell = { ...decl, requires: decl.requires.filter((r) => !reqs.includes(r)) };
    editDeclFile(join(CELLS_DIR, `${cellName}.cell.toml`), join(CELLS_DIR, `${cellName}.cell.toml`), updated, (text) => editCellRequires(text, { remove: reqs }));
  }
}
