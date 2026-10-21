/**
 * The seam for a cell edit: a store-coordinated change to one cell. A cell edit includes a
 * comment-preserving declaration rewrite (text surgery, with `serializeCell` as the
 * fallback), an ownership move, and a requires rewrite in the dependent cells.
 *
 * A refusal throws the error message of the CLI. `main().catch` prints the message with the
 * `cells: ` prefix and exits with code 1, which is the exact stderr that the CLI tests pin.
 * A success returns an outcome summary that the `cmd*` adapters in `mutate.ts` render.
 *
 * This module handles the three declaration-centric operations only. `assign` and
 * `unassign` keep their own seam in `assign.ts`, because they move files and not cells.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validCellName } from './assign.js';
import { checkLeakage } from './crossings.js';
import { type Cell, editCellDataRequires, editCellName, editCellRequires, serializeCell } from './declaration.js';
import { CELLS_DIR, loadDeclarations, loadOwnership, writeOwnership } from './io.js';
import { loadCrossings } from './pipeline.js';

/**
 * Rewrite a declaration file with text surgery that keeps the comments. When the function
 * cannot read the file as text, the parsed and serialized declaration is the fallback.
 * Every edit path uses the same policy. Before this seam existed, each command copied the
 * same steps.
 *
 * For a rename, the read path and the write path differ: the edited text of the OLD
 * declaration goes to the NEW path. The caller then removes the old file. The new file
 * comes first, which keeps the operation atomic.
 */
function editDeclFile(readPath: string, writePath: string, decl: Cell, edit: (text: string) => string): void {
  let content: string;
  try {
    content = edit(readFileSync(readPath, 'utf8'));
  } catch {
    // Never silent. The fallback discards the comments that the file contained, and the
    // promise of the tool is that authored membranes survive its edits.
    console.error(`warning: comment-preserving edit of ${basename(readPath)} failed — rewrote it from the parsed declaration (author comments, if any, are lost)`);
    content = serializeCell(decl);
  }
  writeFileSync(writePath, content);
}

/**
 * Rename a cell: rewrite its declaration file, its ownership entry, and every `requires`
 * reference in the declarations of other cells.
 *
 * The declaration step is atomic: the function writes the new file first and then deletes
 * the old file.
 *
 * The function throws in these cases: an invalid name, a missing source cell, an existing
 * target cell, or an ownership-only `[newName]` entry that the move would overwrite.
 *
 * Both names cross a trust boundary, because they become file names below `.cells/`. A name
 * that contains `..` would move a file outside the store. The function validates the names
 * before it constructs a path.
 */
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
  // the move, and its files would vanish from the partition. Check before any write. The
  // store is already unusual (an undeclared cell), so name the problem instead of
  // destroying data.
  if (ownership[newName] !== undefined && !decls[newName]) {
    throw new Error(`ownership.toml already has a [${newName}] entry with no cell declaration — rename would overwrite it and orphan its files. Fix .cells/ownership.toml first.`);
  }

  // Atomicity: write the NEW declaration before removing the old file. The reverse order
  // leaves `new.cell.toml` with `name = "old"` when a write fails. `loadDeclarations`
  // throws on that mismatch, and every command fails until a person repairs the file.
  const newPath = join(CELLS_DIR, `${newName}.cell.toml`);
  const oldPath = join(CELLS_DIR, `${oldName}.cell.toml`);
  if (oldDecl) {
    editDeclFile(oldPath, newPath, { ...oldDecl, name: newName }, (text) => editCellName(text, newName));
    rmSync(oldPath);
  } else {
    renameSync(oldPath, newPath); // The store entry has no declaration, so there is nothing to rewrite.
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
    // Text surgery for both keys. Each step does nothing when its line is absent.
    editDeclFile(join(CELLS_DIR, `${name}.cell.toml`), join(CELLS_DIR, `${name}.cell.toml`), updated, (text) => editCellRequires(editCellDataRequires(text, { rename: [oldName, newName] }), { rename: [oldName, newName] }));
    requiresUpdated++;
  }
  return { ownedCount, requiresUpdated };
}

/**
 * Remove a cell.
 *
 * Without `--force`, the function refuses when the cell owns files or when another cell
 * requires it, because the state must be resolved first.
 *
 * With `--force`, the owned files become orphans (unowned), and the function removes the
 * `requires` references in the dependent cells. The function returns the outcome.
 */
export function removeCell(name: string, force: boolean): { ownedCount: number; dependents: string[] } {
  // Trust boundary: the name becomes a file name below `.cells/`. A name that contains
  // `..` would delete a file outside the store. The function validates the name before it
  // constructs a path.
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
  // Dependents through EITHER key. A `data-requires` reference dangles in the same way as a `requires` reference.
  const dependents = Object.values(decls)
    .filter((d) => d.name !== name && (d.requires.includes(name) || (d.dataRequires?.includes(name) ?? false)))
    .map((d) => d.name);

  if (!force && (ownedFiles.length > 0 || dependents.length > 0)) {
    if (ownedFiles.length > 0) throw new Error(`"${name}" owns ${ownedFiles.length} file(s) — reassign them (cells assign), or use --force to orphan them (→ unowned)`);
    throw new Error(`"${name}" is required by ${dependents.join(', ')} — update their requires/data-requires, or use --force to strip the references`);
  }

  // Write the ownership map before the declaration goes. If the write fails, the store stays
  // valid: the declaration is still there and the files are still owned. The reverse order
  // leaves ownership that names a cell with no declaration, which needs a manual repair.
  if (ownedFiles.length > 0 || ownership[name] !== undefined) {
    delete ownership[name];
    writeOwnership(ownership);
  }
  rmSync(declPath);

  for (const dep of dependents) {
    const decl = decls[dep];
    const updated: Cell = { ...decl, requires: decl.requires.filter((r) => r !== name), dataRequires: decl.dataRequires?.filter((r) => r !== name) };
    editDeclFile(join(CELLS_DIR, `${dep}.cell.toml`), join(CELLS_DIR, `${dep}.cell.toml`), updated, (text) => editCellRequires(editCellDataRequires(text, { remove: [name] }), { remove: [name] }));
  }
  return { ownedCount: ownedFiles.length, dependents };
}

/**
 * The stale-requires analysis. Both the dry run and `--apply` print this listing. The
 * listing contains the `requires` entries that have no matching import, grouped by cell.
 */
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

/**
 * Apply a stale-requires removal. The function removes the dead entries from the declaration
 * of each cell and keeps the comments.
 */
export function applyStalePrune(byCell: Map<string, string[]>): void {
  const declarations = loadDeclarations();
  for (const [cellName, reqs] of byCell) {
    const decl = declarations[cellName];
    const updated: Cell = { ...decl, requires: decl.requires.filter((r) => !reqs.includes(r)) };
    editDeclFile(join(CELLS_DIR, `${cellName}.cell.toml`), join(CELLS_DIR, `${cellName}.cell.toml`), updated, (text) => editCellRequires(text, { remove: reqs }));
  }
}
