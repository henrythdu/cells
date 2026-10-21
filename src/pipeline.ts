/**
 * The read pipeline. The pipeline collects file-to-file import edges, checks the result,
 * and derives cell crossings. Every analysis path uses this shared seam: the commands,
 * the gate, and the prune-stale step of `mutate`. The edges must be correct, or the
 * command stops. The pipeline renders nothing. The `view` and `graph` cells format what
 * this cell derives.
 */

import type { CellsConfig } from './config.js';
import { type Crossing, deriveCrossings } from './crossings.js';
import type { Cell } from './declaration.js';
import { collectImportEdges, type ImporterFailure } from './importers.js';
import type { ImportEdge, UnresolvedImport } from './imports.js';
import { type Ownership, owningCell } from './ownership.js';

/**
 * Write a warning to stderr when the census contains files that no importer handles. In
 * that case, output derived from crossings can be blind. The warning goes to stderr so
 * machine output on stdout stays clean.
 */
function warnIfBlind(uncoveredExts: string[], ignoreBlindExts: string[]): void {
  const noisy = uncoveredExts.filter((e) => !ignoreBlindExts.includes(e));
  if (noisy.length > 0) {
    console.error(`⚠ no importer for ${noisy.join(', ')} — crossings/impact/structure/graph are BLIND (unverified). Partition/size/validate are unaffected. Silence per-ext via ignore-blind-exts in config.toml.`);
  }
}

/**
 * Safety net. When a command finds no code files, point at `.cells/config.toml`. The usual
 * cause is a mismatch between the language and the configuration, for example TypeScript
 * defaults in a Python repository. This reports the onboarding failure that the detection
 * in `cells init` is meant to prevent.
 */
export function warnIfNoCodeFiles(config: CellsConfig, codeFiles: string[]): void {
  if (codeFiles.length === 0) {
    console.error(`\n⚠ 0 code files match code-exts=[${config.codeExts.join(', ')}] under code-dirs=[${config.codeDirs.join(', ')}] — edit .cells/config.toml.`);
  }
}

/**
 * Get a cell declaration or exit with the standard error message. `cmdShow`, `cmdPayload`,
 * and `cmdImpact` repeat this guard. One home keeps the message consistent.
 */
export function requireCell(declarations: Record<string, Cell>, name: string): Cell {
  const cell = declarations[name];
  if (!cell) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  return cell;
}

/**
 * The shared read pipeline. The function collects import edges, warns about extensions
 * that no importer handles, and derives cell crossings. Every analysis command uses this
 * pipeline, so there is one place where behavior can drift.
 *
 * Set `warn` to false to skip the stderr warning about blind imports. The health report
 * already covers that condition.
 */
export async function loadCrossings(ownership: Ownership, warn = true): Promise<{ edges: ImportEdge[]; crossings: Crossing[]; uncoveredExts: string[]; unresolved: UnresolvedImport[] }> {
  const { edges, uncoveredExts, unresolved, failures, ignoreBlindExts } = await collectImportEdges();
  assertNoImporterFailures(failures);
  if (warn) warnIfBlind(uncoveredExts, ignoreBlindExts);
  // An unresolved import matters only for the partition. A broken specifier in an unowned
  // file has no effect until a cell owns the file. Filtering here keeps the information
  // sections of `health` and `crossings` actionable. In a repository with many unowned
  // files, the noise would otherwise hide the actionable entries.
  const ownedUnresolved = unresolved.filter((u) => owningCell(ownership, u.fromFile) !== undefined);
  return { edges, crossings: deriveCrossings(edges, ownership), uncoveredExts, unresolved: ownedUnresolved };
}

/**
 * Stop with an error when an importer fails. A failed importer makes the graph blind, and
 * no crossings verdict is reliable. See `loadCrossings`.
 */
function assertNoImporterFailures(failures: ImporterFailure[]): void {
  if (failures.length === 0) return;
  const detail = failures.map((f) => `importer "${f.importer}" failed: ${f.error}`).join('; ');
  throw new Error(`${detail} — crossings data incomplete (${failures.map((f) => f.importer).join(', ')} edges missing); gate verdict unreliable.`);
}

/**
 * `cells imports [--json]` prints the raw file-to-file import graph: every resolved edge
 * (including same-cell edges and edges to or from unowned files) and every unresolved
 * specifier. This is the machine surface for external tools, such as import-graph
 * oracles. The gate never reads it.
 */
export async function cmdImports(opts: { json?: boolean } = {}): Promise<void> {
  const { edges, unresolved, uncoveredExts, failures } = await collectImportEdges();
  assertNoImporterFailures(failures);
  if (!opts.json) {
    console.log(`${edges.length} import edge(s), ${unresolved.length} unresolved specifier(s)`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ edges, unresolved, uncoveredExts }, null, 2)}\n`);
}
