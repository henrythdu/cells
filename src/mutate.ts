/** Mutation command bodies — the state-writing half of the CLI: init, rename, remove,
 *  assign, unassign, new, prune-stale, plan. Read/analysis handlers live in commands/
 *  (read.ts + gate.ts); cli.ts keeps the dispatcher + main(). These commands write
 *  after reading, so they re-load the stores fresh instead of using a shared bundle. */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellNameOf, planApply, planAssignment, planGroups, unassignFiles, validCellName } from './assign.js';
import { buildConfig, parseConfig } from './config.js';
import { checkLeakage } from './crossings.js';
import { type Cell, STUB_PURPOSE, serializeCell } from './declaration.js';
import { DEFAULT_IMPORTERS, importableExts } from './importers.js';
import { CELLS_DIR, detectProject, listCodeFiles, loadConfig, loadDeclarations, loadOwnership, readFiles, requireCells, skippedManifestDirs, writeOwnership } from './io.js';
import { computePayloadSize, neighborsOf } from './payload.js';
import { loadCrossings, warnIfNoCodeFiles } from './pipeline.js';
import { isUnsafePath } from './validate.js';

/** `cells config` — show the effective config; `cells config set max-payload-tokens <N>`
 *  edits that one key in place. Targeted line replace (not a rewrite) so the file's
 *  comments and other keys survive. Only max-payload-tokens is settable — the one key
 *  that matters day-to-day; the rest are init-time choices (edit by hand). */
export function cmdConfig(args: string[]): void {
  const cfgPath = join(CELLS_DIR, 'config.toml');
  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const parsed = parseConfig(existing);

  if (args.length === 0) {
    // Read side: the effective values (defaults where the file omits them).
    const lines = [
      'effective config (.cells/config.toml; defaults where omitted):',
      `  max-payload-tokens = ${parsed.maxPayloadTokens}`,
      `  code-dirs = [${parsed.codeDirs.map((d) => `"${d}"`).join(', ')}]`,
      `  code-exts = [${parsed.codeExts.map((e) => `"${e}"`).join(', ')}]`,
    ];
    if (parsed.moduleRoot) lines.push(`  module-root = "${parsed.moduleRoot}"`);
    if (parsed.ignoreBlindExts.length > 0) lines.push(`  ignore-blind-exts = [${parsed.ignoreBlindExts.map((e) => `"${e}"`).join(', ')}]`);
    const layerNames = Object.keys(parsed.layers);
    if (layerNames.length > 0) lines.push(`  layers = { ${layerNames.map((k) => `${k} = "${parsed.layers[Number(k)]}"`).join(', ')} }`);
    console.log(lines.join('\n'));
    return;
  }

  const [verb, key, value, ...rest] = args;
  if (verb !== 'set' || key !== 'max-payload-tokens' || value === undefined || rest.length > 0) {
    console.error('usage: cells config [set max-payload-tokens <N>]');
    process.exit(1);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`cells: max-payload-tokens must be a positive integer (got "${value}")`);
    process.exit(1);
  }

  const re = /^max-payload-tokens\s*=\s*\d+\s*$/m;
  const next = re.test(existing) ? existing.replace(re, `max-payload-tokens = ${n}`) : `${existing.trimEnd()}\nmax-payload-tokens = ${n}\n`;
  writeFileSync(cfgPath, next);
  console.log(`max-payload-tokens = ${n} (was ${parsed.maxPayloadTokens}).`);
}

/** `cells init` — bootstrap a `.cells/` store (idempotent + self-healing). */
export function cmdInit(dryRun = false): void {
  const detected = detectProject();
  // Only ship exts cells can analyze — a repo with importable code shouldn't warn forever
  // about a stray blind fixture (uv's .h). A repo whose languages are ALL blind (pure C)
  // keeps its dominant ext so the BLIND warning fires honestly instead of a silent empty census.
  let codeExts = importableExts(detected.codeExts, DEFAULT_IMPORTERS);
  if (codeExts.length === 0 && detected.codeExts.length > 0) codeExts = [detected.codeExts[0]];
  const { codeDirs } = detected;
  if (dryRun) {
    const ownPath = join(CELLS_DIR, 'ownership.toml');
    const cfgPath = join(CELLS_DIR, 'config.toml');
    const needed: string[] = [];
    if (!existsSync(ownPath)) needed.push('ownership.toml');
    if (!existsSync(cfgPath)) needed.push('config.toml');
    if (needed.length === 0) {
      console.log(`${CELLS_DIR}/ already initialized — nothing to do.`);
    } else {
      console.log(`Would create ${CELLS_DIR}/ with ${needed.join(' + ')}.`);
      console.log(`Would detect: code-exts = [${codeExts.join(', ')}], code-dirs = [${codeDirs.join(', ')}].`);
    }
    return;
  }
  mkdirSync(CELLS_DIR, { recursive: true });
  const ownPath = join(CELLS_DIR, 'ownership.toml');
  const cfgPath = join(CELLS_DIR, 'config.toml');
  const created: string[] = [];
  if (!existsSync(ownPath)) {
    writeOwnership({});
    created.push('ownership.toml');
  }
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, buildConfig(codeExts, codeDirs));
    created.push('config.toml');
  }
  if (created.length === 0) {
    console.log(`${CELLS_DIR}/ already initialized — nothing to do.`);
    return;
  }
  console.log(`Initialized ${CELLS_DIR}/: created ${created.join(' + ')}.`);
  console.log(`Detected: code-exts = [${codeExts.join(', ')}], code-dirs = [${codeDirs.join(', ')}].`);
  console.log('Next: `cells assign <cell> <file...>` to start partitioning.');
}

/** `cells rename <old> <new>` — rename a cell across the store: .cell.toml file,
 *  ownership.toml key, and every other cell's requires reference. BOTH names are a trust
 *  boundary: they become filenames under .cells/ — a `..`-laden oldName would move a file
 *  outside the store (validated before any path is constructed). */
export function cmdRename(oldName: string, newName: string): void {
  if (!validCellName(oldName) || !validCellName(newName)) {
    console.error(`cells: invalid cell name "${oldName}" → "${newName}" — use only letters, numbers, dashes, underscores.`);
    process.exit(1);
  }

  if (!existsSync(join(CELLS_DIR, `${oldName}.cell.toml`))) {
    console.error(`cells: no cell named "${oldName}"`);
    process.exit(1);
  }

  if (existsSync(join(CELLS_DIR, `${newName}.cell.toml`))) {
    console.error(`cells: "${newName}" already exists — can't overwrite`);
    process.exit(1);
  }

  const decls = loadDeclarations();
  const oldDecl = decls[oldName];

  renameSync(join(CELLS_DIR, `${oldName}.cell.toml`), join(CELLS_DIR, `${newName}.cell.toml`));

  if (oldDecl) {
    oldDecl.name = newName;
    writeFileSync(join(CELLS_DIR, `${newName}.cell.toml`), serializeCell(oldDecl));
  }

  const ownership = loadOwnership();
  const ownedCount = ownership[oldName]?.length ?? 0;
  if (ownership[oldName]) {
    ownership[newName] = ownership[oldName];
    delete ownership[oldName];
    writeOwnership(ownership);
  }

  let requiresUpdated = 0;
  for (const [name, decl] of Object.entries(decls)) {
    if (name === oldName) continue;
    if (decl.requires.includes(oldName)) {
      decl.requires = decl.requires.map((r) => (r === oldName ? newName : r));
      writeFileSync(join(CELLS_DIR, `${name}.cell.toml`), serializeCell(decl));
      requiresUpdated++;
    }
  }

  console.log(`Renamed "${oldName}" → "${newName}".`);
  if (ownedCount > 0) console.log(`  Ownership: ${ownedCount} file(s).`);
  if (requiresUpdated > 0) console.log(`  Requires: updated ${requiresUpdated} cell(s).`);
}

/** `cells remove <cell> [--force]` — delete a cell from the store. Refuses if the cell
 *  owns files or is required by others (state must be resolved first); --force orphans
 *  the files (→ unowned) and strips requires references from other cells. */
export function cmdRemove(name: string, force: boolean): void {
  // Trust boundary: the name becomes a filename under .cells/ — a `..`-laden name would
  // delete a file outside the store (validated before any path is constructed).
  if (!validCellName(name)) {
    console.error(`cells: invalid cell name "${name}" — use only letters, numbers, dashes, underscores.`);
    process.exit(1);
  }
  const declPath = join(CELLS_DIR, `${name}.cell.toml`);
  if (!existsSync(declPath)) {
    console.error(`cells: no cell named "${name}"`);
    process.exit(1);
  }

  const ownership = loadOwnership();
  const ownedFiles = ownership[name] ?? [];
  const decls = loadDeclarations();
  const dependents = Object.values(decls)
    .filter((d) => d.name !== name && d.requires.includes(name))
    .map((d) => d.name);

  if (!force && (ownedFiles.length > 0 || dependents.length > 0)) {
    if (ownedFiles.length > 0) console.error(`cells: "${name}" owns ${ownedFiles.length} file(s) — reassign them (cells assign), or use --force to orphan them (→ unowned)`);
    if (dependents.length > 0) console.error(`cells: "${name}" is required by ${dependents.join(', ')} — update their requires, or use --force to strip the references`);
    process.exit(1);
  }

  rmSync(declPath);

  if (ownedFiles.length > 0 || ownership[name] !== undefined) {
    delete ownership[name];
    writeOwnership(ownership);
  }

  for (const dep of dependents) {
    const decl = decls[dep];
    decl.requires = decl.requires.filter((r) => r !== name);
    writeFileSync(join(CELLS_DIR, `${dep}.cell.toml`), serializeCell(decl));
  }

  console.log(`Removed cell "${name}".`);
  if (ownedFiles.length > 0) console.log(`  ${ownedFiles.length} file(s) orphaned → unowned.`);
  if (dependents.length > 0) console.log(`  Stripped requires from: ${dependents.join(', ')}.`);
}

/** `cells assign <cell> <file...>` — move files into a cell; stub its declaration if new. */
export function cmdAssign(cell: string, files: string[], dryRun = false): void {
  // Trust boundary: assign maps FILE paths — an absolute or `..`-escaping path would be
  // written into ownership and later read outside the repo (validatePartition flags the
  // entry; readFiles refuses it). Reject at the write side so the command can't lie.
  const unsafe = files.filter((f) => isUnsafePath(f));
  if (unsafe.length > 0) {
    console.error(`cells: assign target(s) outside the repo: ${unsafe.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const invalid = files.filter((f) => !existsSync(f) || !statSync(f).isFile());
  if (invalid.length > 0) {
    const dirs = invalid.filter((f) => existsSync(f));
    console.error(
      `cells: assign target(s) not files: ${invalid.join(', ')}${dirs.length > 0 ? ` — ${dirs.join(', ')} is a directory; assign takes files (adopt a tree via \`cells plan\` or write .cells/ownership.toml)` : ' — no such file'}`,
    );
    process.exitCode = 1;
    return;
  }
  const declPath = join(CELLS_DIR, `${cell}.cell.toml`);
  const declarations = loadDeclarations();
  // Symlink aliases (stress finding: cxx): the census walks through symlinks and records the
  // ALIAS path; users type canonical ones. Assigning a canonical path when the same inode is
  // already owned under its alias would double-own the file (validate catches it later,
  // silently). Normalize each assigned file to its already-owned path so ownership stays
  // census-consistent; warn so the rename is visible.
  const ownership0 = loadOwnership();
  const ownedByReal = new Map<string, { path: string; owner: string }>();
  for (const [owner, owned] of Object.entries(ownership0)) {
    for (const path of owned) {
      try {
        ownedByReal.set(realpathSync(path), { path, owner });
      } catch {
        /* dangling owned entry — validate flags it */
      }
    }
  }
  // Census aliases: the census records whichever symlink path it walked first; a user
  // typing the other path (canonical or alias) would write an entry the census can't see
  // (reads as dangling/orphan). Prefer the census path for the same inode.
  const censusByReal = new Map<string, string>();
  for (const p of listCodeFiles()) {
    try {
      censusByReal.set(realpathSync(p), p);
    } catch {
      /* vanished between census and assign — keep the typed path */
    }
  }
  const normalized: string[] = [];
  const seen = new Set<string>(); // realpaths already normalized in this command
  for (const f of files) {
    const real = realpathSync(f); // validated as an existing file above — realpath succeeds
    if (seen.has(real)) {
      console.log(`note: ${f} is the same file as one already being assigned — skipped.`);
      continue;
    }
    seen.add(real);
    const existing = ownedByReal.get(real);
    if (existing !== undefined) {
      if (existing.owner === cell) {
        console.log(`note: ${f} already owned by ${cell} (as ${existing.path} — symlink alias).`);
        continue;
      }
      console.log(`note: ${f} is owned as ${existing.path} (symlink alias, cell ${existing.owner}) — moving that entry to ${cell}.`);
      normalized.push(existing.path);
      continue;
    }
    const censusPath = censusByReal.get(real);
    if (censusPath !== undefined && censusPath !== f) {
      console.log(`note: ${f} is known to the census as ${censusPath} (symlink alias) — assigning that path.`);
      normalized.push(censusPath);
      continue;
    }
    normalized.push(f);
  }
  // planAssignment validates the name (throws → main().catch surfaces it), decides the stub, computes ownership.
  const { stub, ownership } = planAssignment(ownership0, cell, normalized, existsSync(declPath));
  // Size pre-flight: warn if the destination would exceed its ceiling after the move.
  const cellDecl = declarations[cell] ?? stub;
  if (cellDecl) {
    const ceiling = cellDecl.ceiling ?? loadConfig().maxPayloadTokens;
    const pct = computePayloadSize(cellDecl, ownership[cell] ?? [], readFiles(ownership[cell] ?? []), neighborsOf(cellDecl, declarations), readFiles(cellDecl.tests ?? [])).tokens / ceiling;
    if (pct > 1) console.log(`⚠ ${cell} would be ${Math.round(pct * 100)}% of the ceiling after this move — consider peeling a file out first (\`cells size\`).`);
  }
  if (dryRun) {
    console.log(stub ? `Would create stub ${cell}.cell.toml + assign ${normalized.length} file(s) to "${cell}".` : `Would assign ${normalized.length} file(s) to "${cell}".`);
    return;
  }
  if (stub) writeFileSync(declPath, serializeCell(stub)); // stub before ownership — a write failure leaves no dirty state
  writeOwnership(ownership);
  console.log(stub ? `Assigned ${normalized.length} file(s) to "${cell}" — created stub declaration.\nEdit ${declPath} (purpose/provides/requires), then run \`cells health\`.` : `Assigned ${normalized.length} file(s) to "${cell}".`);
}

/** `cells unassign <file...>` — remove files from their cell (→ orphan). */
export function cmdUnassign(files: string[], dryRun = false): void {
  const ownership = loadOwnership();
  const ownedBefore = new Set(Object.values(ownership).flat());
  const removed = files.filter((f) => ownedBefore.has(f));
  if (dryRun) {
    if (removed.length === 0) {
      console.log('Would do nothing — none of those files are owned.');
    } else {
      console.log(`Would unassign ${removed.length} file(s).`);
    }
    return;
  }
  writeOwnership(unassignFiles(ownership, files));
  if (removed.length === 0) {
    console.log('No changes — none of those files were owned.');
    return;
  }
  console.log(`Unassigned ${removed.length} file(s) — now orphan.`);
}

/** `cells new <name> [--purpose ...] [--provides a,b] [--requires a,b] [--layer N]` — scaffold a
 *  .cell.toml declaration. Declare-first flow: `cells new` writes the contract, then `cells assign`
 *  moves files in (assign also stubs on demand — new is for declaring the contract up front). */
export function cmdNew(args: string[]): void {
  // Name must be the first token — flag VALUES are not positions: `cells new --layer 2 db`
  // must not silently create a cell named "2".
  if (args[0] === undefined || args[0].startsWith('--')) {
    console.error('usage: cells new <name> [--purpose "..."] [--provides a,b] [--requires a,b] [--layer N]');
    process.exit(1);
  }
  const name = args[0];
  if (!validCellName(name)) {
    console.error(`cells: invalid cell name "${name}" — use only letters, numbers, dashes, underscores.`);
    process.exit(1);
  }

  const flags: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const val = args[i + 1];
    flags[a] = val !== undefined && !val.startsWith('--') ? val : undefined;
  }
  const declPath = join(CELLS_DIR, `${name}.cell.toml`);
  if (existsSync(declPath)) {
    console.error(`cells: cell "${name}" already exists (${declPath}) — use assign or rename instead.`);
    process.exit(1);
  }
  const split = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const cell: Cell = {
    name,
    purpose: flags['--purpose'] ?? STUB_PURPOSE,
    provides: split(flags['--provides']),
    requires: split(flags['--requires']),
  };
  const layer = flags['--layer'];
  if (layer !== undefined) {
    // strict decimal — Number() alone would accept '', '0x10', '1e3'
    if (!/^\d+$/.test(layer)) {
      console.error(`cells: --layer must be a non-negative integer, got "${layer}".`);
      process.exit(1);
    }
    cell.layer = Number(layer);
  }
  writeFileSync(declPath, serializeCell(cell));
  console.log(`Created cell "${name}" (${declPath}).`);
  console.log(`Next: \`cells assign ${name} <file...>\` then \`cells health\`.`);
  if (cell.purpose === STUB_PURPOSE) console.log(`Note: purpose is a stub — edit ${declPath} to describe the cell.`);
}

/** `cells prune-stale [--apply]` — remove requires that are declared but never imported (stale).
 *  Dry-run by default: prints what would change, touches nothing. --apply rewrites the .cell.toml files.
 *  Stale stays info-level in health ("maybe a data dependency or future plan") — this command is the
 *  explicit opt-in cleanup; the agent decides, the tool applies. */
export async function cmdPruneStale(apply: boolean): Promise<void> {
  const ownership = loadOwnership();
  const { crossings } = await loadCrossings(ownership, false);
  const declarations = loadDeclarations();
  const stale = checkLeakage(crossings, declarations).filter((l) => l.kind === 'stale');
  if (stale.length === 0) {
    console.log('No stale requires — every declared requirement is imported.');
    return;
  }
  const byCell = new Map<string, string[]>();
  for (const s of stale) {
    const list = byCell.get(s.fromCell) ?? [];
    list.push(s.toCell);
    byCell.set(s.fromCell, list);
  }
  const lines = [`${stale.length} stale require(s) — declared but no import found:`];
  for (const [cell, reqs] of byCell) lines.push(`  ${cell} → ${reqs.join(', ')}`);
  if (!apply) {
    lines.push('Dry run — nothing changed. Re-run with --apply to remove them.');
    console.log(lines.join('\n'));
    return;
  }
  for (const [cellName, reqs] of byCell) {
    const decl = declarations[cellName];
    decl.requires = decl.requires.filter((r) => !reqs.includes(r));
    writeFileSync(join(CELLS_DIR, `${cellName}.cell.toml`), serializeCell(decl));
  }
  lines.push(`Removed from ${byCell.size} cell declaration(s). Run \`cells health\` to confirm.`);
  console.log(lines.join('\n'));
}

/** `cells plan` — scan code-dirs and propose a partition: group files into cells
 *  (crate/package-aware via planGroups — a monorepo's crates/packages collapse to one
 *  cell each instead of every subdir exploding; invalid-name dirs fold to a valid
 *  ancestor), print suggested .cell.toml declarations + ownership.toml to stdout.
 *  The LLM reviews and curates — no files are written.
 *  `--apply` executes the printed plan: creates the stub declarations + ownership
 *  entries. Existing cells are never overwritten and already-owned files are never
 *  stolen (curated state survives); newly created cells start with empty requires —
 *  the gate still confronts you after applying (crossings will be red). */
export function cmdPlan(apply = false, dryRun = false): void {
  const config = loadConfig();
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const skipped = skippedManifestDirs(config.codeExts); // skip-named dirs holding code/manifests — the census can't see them
  const skippedNote = skipped.length > 0 ? `\n(census note) ${skipped.length} skip-named dir(s) hold code or a build manifest and are excluded — real packages hidden from ownership: ${skipped.join(', ')}` : '';
  const groups = planGroups(codeFiles);
  const keys = [...groups.keys()].sort();
  const names = new Map(keys.map((k) => [k, cellNameOf(k)]));
  const grouped = [...groups.values()].reduce((n, f) => n + f.length, 0);
  const unowned = codeFiles.length - grouped; // files no crate/package/__init__ unit claims — the coverage signal

  if (dryRun && !apply) console.error('Note: plain `plan` is read-only — --dry-run only matters with --apply.');

  if (apply) {
    requireCells();

    const existing = new Set(Object.keys(loadDeclarations()));
    const proposed = new Map(keys.map((k) => [names.get(k)!, groups.get(k)!]));
    const { stubs, ownership, skipped, adopted, kept } = planApply(loadOwnership(), proposed, existing);
    const unownedAfter = codeFiles.length - adopted - kept;
    const outcome = `created ${stubs.length} cell declaration(s), skipped ${skipped} existing, adopted ${adopted} file(s), kept ${kept} already-owned${unownedAfter > 0 ? `, ${unownedAfter} left unowned` : ''}.`;
    const summary = dryRun
      ? `Would apply: ${outcome}${skippedNote}\nDry run — nothing changed. Re-run without --dry-run to apply.`
      : `Applied plan: ${outcome}${skippedNote}\nRun \`cells health\` — crossings will be red until requires are filled.`;
    if (dryRun) {
      console.log(summary);
      return;
    }
    for (const s of stubs) writeFileSync(join(CELLS_DIR, `${s.name}.cell.toml`), serializeCell(s)); // stubs before ownership — a write failure leaves no dirty state
    writeOwnership(ownership);
    console.log(summary);
    return;
  }

  console.log('# Proposed cell declarations (.cells/*.cell.toml files)');
  console.log('# SUGGESTION ONLY — nothing is enforced; cells may be deleted, renamed, or');
  console.log('# repartitioned freely. Loose files (no crate/package/__init__ unit) are left');
  console.log('# unowned — unowned files are not violations, they show as orphans.');
  console.log('# Review and curate, then create them.');
  console.log('');
  for (const key of keys) {
    console.log(`## ${names.get(key)}`);
    console.log(`name = "${names.get(key)}"`);
    console.log(`purpose = "${STUB_PURPOSE}"`);
    console.log('provides = []');
    console.log('requires = []');
    console.log('');
  }

  console.log('# Proposed ownership (.cells/ownership.toml)');
  console.log('# Review and curate, then write to .cells/ownership.toml.');
  console.log('');
  for (const key of keys) {
    console.log(`[${names.get(key)}]`);
    console.log(
      `files = [${groups
        .get(key)!
        .map((f) => `"${f}"`)
        .join(', ')}]`,
    );
    console.log('');
  }
  if (unowned > 0) console.log(`# ${unowned} of ${codeFiles.length} file(s) stay unowned (orphans — no crate/package/__init__ unit; assign or .cells/ignore).`);
}
