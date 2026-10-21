/**
 * The bodies of the mutation commands: the half of the CLI that writes state. These
 * commands are init, rename, remove, assign, unassign, new, prune-stale, and plan.
 *
 * The read and analysis handlers live in `commands/read.ts` and in `gate.ts` at the root of
 * `src/`. `cli.ts` keeps the dispatcher and `main()`.
 *
 * These commands write after they read. Therefore they load the stores again with fresh
 * data and do not use a shared bundle.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellNameOf, planApply, planAssignment, planGroups, unassignFiles, validCellName } from './assign.js';
import { applyStalePrune, findStaleRequires, removeCell, renameCell } from './celledit.js';
import { buildConfig, parseConfig } from './config.js';
import { type Cell, STUB_PURPOSE, serializeCell } from './declaration.js';
import { DEFAULT_IMPORTERS, importableExts } from './importers.js';
import { CELLS_DIR, detectProject, listCodeFiles, loadConfig, loadDeclarations, loadOwnership, readFiles, requireCells, SKIP_DIRS, skippedManifestDirs, writeOwnership } from './io.js';
import { computePayloadSize, neighborsOf } from './payload.js';
import { warnIfNoCodeFiles } from './pipeline.js';
import { isUnsafePath } from './validate.js';

/**
 * `cells config` shows the effective configuration. `cells config set max-payload-tokens
 * <N>` changes that one key.
 *
 * The function edits the text and does not serialize the parsed config, so the comments and
 * the other keys stay. A duplicate copy of the key, or a copy that sits inside a table, is
 * removed, and the key goes back to the top level. The result is parsed before the command
 * reports success.
 *
 * Only max-payload-tokens is settable, because it is the one key that matters each day.
 * The other keys are choices for `init`, and a person edits them by hand.
 */
export function cmdConfig(args: string[]): void {
  const cfgPath = join(CELLS_DIR, 'config.toml');
  // A UTF-8 byte-order mark is invisible, and smol-toml rejects it, so strip it before any
  // split. The write then produces a file without one, which is the repair.
  const existing = (existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '').replace(/^\uFEFF/, '');

  if (args.length === 0) {
    const parsed = parseConfig(existing);
    // The read side: the effective values, with the defaults where the file has no value.
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

  // Replace the whole line, not only a decimal value: a person can indent the key, add a
  // trailing comment, or write a TOML integer as `16_000`. A narrow pattern missed every
  // such line and appended a second key, and TOML forbids a redefined key.
  //
  // Only a line BEFORE the first table header is the setting. A bare key after `[layers]`
  // belongs to that table, where it is an unknown layer name, so replacing it there would
  // change nothing while reporting success. A stray copy inside a table is removed.
  const isSettingLine = (l: string): boolean => /^[ \t]*max-payload-tokens[ \t]*=/.test(l);
  const isHeader = (l: string): boolean => /^[ \t]*\[/.test(l);
  const line = `max-payload-tokens = ${n}`;
  // Keep the line ending of the file. A config written on Windows uses CRLF, and a mixed file
  // makes every later diff show the whole file as changed.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const raw = existing.split(/\r?\n/);
  const headerIdx = raw.findIndex(isHeader);
  const bodyEnd = headerIdx === -1 ? raw.length : headerIdx;
  const settingIdx = raw.findIndex((l, i) => i < bodyEnd && isSettingLine(l));
  let next: string;
  if (settingIdx !== -1) {
    // Keep the first line and drop any later copies, so a file that an older version
    // corrupted with a duplicate key becomes valid again.
    const kept = raw.filter((l, i) => i === settingIdx || !isSettingLine(l));
    kept[settingIdx] = line;
    next = kept.join(eol);
  } else {
    // Insert above the first header, or at the end when the file has no table.
    const kept = raw.filter((l) => !isSettingLine(l));
    const at = kept.findIndex(isHeader);
    if (at === -1) {
      const head = kept.join(eol).trimEnd();
      next = `${head ? `${head}${eol}` : ''}${line}${eol}`;
    } else {
      // Drop the blank lines that precede the header, then put the key and one blank line
      // there, so the key cannot join the table below it.
      let cut = at;
      while (cut > 0 && kept[cut - 1].trim() === '') cut--;
      kept.splice(cut, at - cut, line, '');
      next = kept.join(eol);
    }
  }
  // `set` is the repair command, so an unreadable result must fail loudly, and it must fail
  // BEFORE the write: a command that reports an error should not change the file. The parse of
  // the old text only supplies the previous value; its own warning is muted because it
  // complains about the very key this command just moved.
  const warn = console.warn;
  console.warn = () => {};
  let was: number | undefined;
  let problem: string | undefined;
  try {
    was = parseConfig(existing).maxPayloadTokens;
  } catch {
    was = undefined;
  }
  try {
    parseConfig(next);
  } catch (e) {
    problem = (e as Error).message;
  } finally {
    console.warn = warn;
  }
  if (problem !== undefined) {
    console.error(`cells: .cells/config.toml is still invalid: ${problem}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(cfgPath, next);
  console.log(`max-payload-tokens = ${n} (was ${was ?? 'unreadable'}).`);
}

/** `cells init` creates the `.cells/` store. The command is idempotent and repairs a partial store. */
export function cmdInit(dryRun = false): void {
  const detected = detectProject();
  // Include only the extensions that cells can analyze. A repository with importable code
  // should not warn permanently about a stray blind fixture (a .h file in uv).
  //
  // A repository whose languages are ALL blind (pure C) keeps its most frequent extension,
  // so the BLIND warning appears correctly instead of a silent empty census.
  let codeExts = importableExts(detected.codeExts, DEFAULT_IMPORTERS);
  if (codeExts.length === 0 && detected.codeExts.length > 0) codeExts = [detected.codeExts[0]];
  const { codeDirs } = detected;
  const ownPath = join(CELLS_DIR, 'ownership.toml');
  const cfgPath = join(CELLS_DIR, 'config.toml');
  if (dryRun) {
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

/**
 * `cells rename <old> <new>` prints the result of the cell edit seam. A refusal message
 * appears through `main().catch` as `cells: <message>` with exit code 1, which is the
 * stderr that the CLI tests pin.
 */
export function cmdRename(oldName: string, newName: string): void {
  const { ownedCount, requiresUpdated } = renameCell(oldName, newName);
  console.log(`Renamed "${oldName}" → "${newName}".`);
  if (ownedCount > 0) console.log(`  Ownership: ${ownedCount} file(s).`);
  if (requiresUpdated > 0) console.log(`  Requires: updated ${requiresUpdated} cell(s).`);
}

/** `cells remove <cell> [--force]` prints the result of the cell edit seam. */
export function cmdRemove(name: string, force: boolean): void {
  const { ownedCount, dependents } = removeCell(name, force);
  console.log(`Removed cell "${name}".`);
  if (ownedCount > 0) console.log(`  ${ownedCount} file(s) orphaned → unowned.`);
  if (dependents.length > 0) console.log(`  Stripped requires from: ${dependents.join(', ')}.`);
}

/** `cells assign <cell> <file...>` moves files into a cell and creates a stub declaration when the cell is new. */
export function cmdAssign(cell: string, files: string[], dryRun = false): void {
  // Trust boundary: assign takes FILE paths. The function writes the paths into ownership,
  // and a later read would reach outside the repository for an absolute path or a path that
  // contains `..`. `validatePartition` reports such an entry and `readFiles` refuses it.
  // Reject the path at the write side, so the command cannot report a false success.
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
  // Symlink aliases: the census walks through symlinks and records the ALIAS path, but a
  // user types the canonical path. If the command assigns a canonical path while the same
  // inode is already owned under its alias, the file would have two owners. `validate`
  // reports that condition later, without a warning.
  //
  // Normalize each assigned file to the path that is already owned, so ownership stays
  // consistent with the census. Write a note, so the rename is visible.
  const ownership0 = loadOwnership();
  const ownedByReal = new Map<string, { path: string; owner: string }>();
  for (const [owner, owned] of Object.entries(ownership0)) {
    for (const path of owned) {
      try {
        ownedByReal.set(realpathSync(path), { path, owner });
      } catch {
        /* The owned entry dangles. validate reports it. */
      }
    }
  }
  // The census records the first symlink path that it walked. If a user types the other
  // path (canonical or alias), the command would write an entry that the census cannot see,
  // and the entry would read as dangling or as an orphan. Therefore use the census path for
  // the same inode.
  const censusByReal = new Map<string, string>();
  for (const p of listCodeFiles()) {
    try {
      censusByReal.set(realpathSync(p), p);
    } catch {
      /* The file disappeared between the census and assign. Keep the typed path. */
    }
  }
  const normalized: string[] = [];
  const seen = new Set<string>(); // The real paths that this command already normalized.
  // Resolve with a guard. The existence check above passed, but a file can vanish before
  // this line, and a raw ENOENT would print as an internal error instead of a refusal.
  const realOf = (f: string): string | null => {
    try {
      return realpathSync(f);
    } catch {
      return null;
    }
  };
  for (const f of files) {
    const real = realOf(f);
    if (real === null) {
      console.error(`cells: ${f} disappeared before it could be assigned — nothing changed.`);
      process.exitCode = 1;
      return;
    }
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
  // Ownership partitions the CENSUS. A target that is skip-listed or that is not code would
  // be owned but invisible to the importers. `validate` would report it as "outside-census"
  // permanently, and no command could repair it. Refuse the target at the write side, as the
  // unsafe-path check does. The correct repair is a configuration change: skip-dirs,
  // code-dirs, or code-exts.
  const outside = normalized.filter((f) => {
    const real = realOf(f);
    return real === null || !censusByReal.has(real); // A vanished target is not in the census either.
  });
  if (outside.length > 0) {
    console.error(
      `cells: assign target(s) outside the code census: ${outside.join(', ')} — they exist but the census never walks them (skip-listed dir, non-code extension, or outside code-dirs). Fix .cells/config.toml (skip-dirs / code-dirs / code-exts) to adopt them; ownership partitions the census.`,
    );
    process.exitCode = 1;
    return;
  }
  // planAssignment validates the name and throws on a bad name. main().catch reports that error. It also decides whether to create a stub and computes the ownership map.
  const { stub, ownership } = planAssignment(ownership0, cell, normalized, existsSync(declPath));
  // Size pre-flight: warn when the destination would be over its ceiling after the move.
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
  if (stub) writeFileSync(declPath, serializeCell(stub)); // Write the stub before ownership. A write failure then leaves no inconsistent state.
  writeOwnership(ownership);
  console.log(stub ? `Assigned ${normalized.length} file(s) to "${cell}" — created stub declaration.\nEdit ${declPath} (purpose/provides/requires), then run \`cells health\`.` : `Assigned ${normalized.length} file(s) to "${cell}".`);
}

/** `cells unassign <file...>` removes files from their cell and makes them orphans. */
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

/**
 * `cells new <name> [--purpose ...] [--provides a,b] [--requires a,b] [--layer N]` creates
 * a `.cell.toml` declaration.
 *
 * This is the declare-first flow: `cells new` writes the contract, and then `cells assign`
 * moves files into the cell. `assign` also creates a stub when it needs one, and `new` is
 * for declaring the contract first.
 */
export function cmdNew(args: string[]): void {
  // The name must be the first token, because a flag VALUE is not a position. For example,
  // `cells new --layer 2 db` must not create a cell named "2" without a warning.
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
    // Strict decimal form. Number() alone would accept '', '0x10', and '1e3'.
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

/**
 * `cells prune-stale [--apply]` removes `requires` entries that a cell declares but never
 * imports (stale entries).
 *
 * The command is a dry run by default: it prints the changes and touches no file. `--apply`
 * rewrites the `.cell.toml` files.
 *
 * `health` keeps a stale entry at the information level, because the entry can be a data
 * dependency or a future plan. This command is the explicit cleanup, which the agent
 * chooses and the tool applies.
 */
export async function cmdPruneStale(apply: boolean): Promise<void> {
  const byCell = await findStaleRequires();
  const staleCount = [...byCell.values()].reduce((n, reqs) => n + reqs.length, 0);
  if (staleCount === 0) {
    console.log('No stale requires — every declared requirement is imported.');
    return;
  }
  const lines = [`${staleCount} stale require(s) — declared but no import found:`];
  for (const [cell, reqs] of byCell) lines.push(`  ${cell} → ${reqs.join(', ')}`);
  if (!apply) {
    lines.push('Dry run — nothing changed. Re-run with --apply to remove them.');
    console.log(lines.join('\n'));
    return;
  }
  applyStalePrune(byCell);
  lines.push(`Removed from ${byCell.size} cell declaration(s). Run \`cells health\` to confirm.`);
  console.log(lines.join('\n'));
}

/**
 * `cells plan` scans code-dirs and proposes a partition. `planGroups` groups the files into
 * cells and respects crates and packages: in a monorepo, each crate or package becomes one
 * cell, and the subdirectories do not multiply. A directory with an invalid name folds into
 * a valid ancestor.
 *
 * The command prints the suggested `.cell.toml` declarations and the `ownership.toml` file
 * to stdout. A model reviews and curates them, and the command writes no file.
 *
 * `--apply` executes the printed plan: it creates the stub declarations and the ownership
 * entries. The command never overwrites an existing cell and never takes a file that a cell
 * already owns, so curated state survives. A new cell starts with empty `requires`, and the
 * gate still reports problems after the command: the crossings fail.
 */
export function cmdPlan(apply = false, dryRun = false): void {
  const config = loadConfig();
  const codeFiles = listCodeFiles();
  warnIfNoCodeFiles(config, codeFiles);
  const skipped = skippedManifestDirs(config.codeExts, '.', new Set(config.skipDirs ?? SKIP_DIRS)); // Skip-named directories that hold code or a build manifest. The census cannot see them.
  const skippedNote = skipped.length > 0 ? `\n(census note) ${skipped.length} skip-named dir(s) hold code or a build manifest and are excluded — real packages hidden from ownership: ${skipped.join(', ')}` : '';
  const groups = planGroups(codeFiles);
  const keys = [...groups.keys()].sort();
  const names = new Map(keys.map((k) => [k, cellNameOf(k)]));
  const grouped = [...groups.values()].reduce((n, f) => n + f.length, 0);
  const unowned = codeFiles.length - grouped; // The files that no crate, package, or __init__ unit claims: the coverage signal.

  if (dryRun && !apply) console.error('Note: plain `plan` is read-only — --dry-run only matters with --apply.');

  if (apply) {
    requireCells();

    const existing = new Set(Object.keys(loadDeclarations()));
    const proposed = new Map(keys.map((k) => [names.get(k)!, groups.get(k)!]));
    const { stubs, ownership, skipped: skippedExisting, adopted, kept } = planApply(loadOwnership(), proposed, existing);
    const unownedAfter = codeFiles.length - adopted - kept;
    const outcome = `created ${stubs.length} cell declaration(s), skipped ${skippedExisting} existing, adopted ${adopted} file(s), kept ${kept} already-owned${unownedAfter > 0 ? `, ${unownedAfter} left unowned` : ''}.`;
    const summary = dryRun
      ? `Would apply: ${outcome}${skippedNote}\nDry run — nothing changed. Re-run without --dry-run to apply.`
      : `Applied plan: ${outcome}${skippedNote}\nRun \`cells health\` — crossings will be red until requires are filled.`;
    if (dryRun) {
      console.log(summary);
      return;
    }
    for (const s of stubs) writeFileSync(join(CELLS_DIR, `${s.name}.cell.toml`), serializeCell(s)); // Write the stubs before ownership. A write failure then leaves no inconsistent state.
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
