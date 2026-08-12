/** The read pipeline — gather file→file import edges, guard the result, derive cell
 *  crossings. The shared seam every analysis path routes through (commands, gate,
 *  mutate's prune-stale): edges are honest or the command dies. Renders nothing —
 *  view/graph format what this cell derives. */

import type { CellsConfig } from './config.js';
import { type Crossing, deriveCrossings } from './crossings.js';
import type { Cell } from './declaration.js';
import { collectImportEdges } from './importers.js';
import type { ImportEdge, UnresolvedImport } from './imports.js';
import { type Ownership, owningCell } from './ownership.js';

/** Warn (stderr) when census files exist that no importer handles — the
 * crossings-derived output may be BLIND. Goes to stderr so machine output (stdout) stays clean. */
function warnIfBlind(uncoveredExts: string[], ignoreBlindExts: string[]): void {
  const noisy = uncoveredExts.filter((e) => !ignoreBlindExts.includes(e));
  if (noisy.length > 0) {
    console.error(`⚠ no importer for ${noisy.join(', ')} — crossings/impact/structure/graph are BLIND (unverified). Partition/size/validate are unaffected. Silence per-ext via ignore-blind-exts in config.toml.`);
  }
}

/** Safety net: when a command finds zero code files, point at config.toml — the usual cause
 *  is a language/config mismatch (e.g. TS defaults on a Python repo). Surfaces the onboarding
 *  failure that `cells init`'s detection is meant to prevent. */
export function warnIfNoCodeFiles(config: CellsConfig, codeFiles: string[]): void {
  if (codeFiles.length === 0) {
    console.error(`\n⚠ 0 code files match code-exts=[${config.codeExts.join(', ')}] under code-dirs=[${config.codeDirs.join(', ')}] — edit .cells/config.toml.`);
  }
}

/** Get a cell declaration or die with the standard error — cmdShow/cmdPayload/cmdImpact
 *  all repeat this guard; one home keeps the message consistent. */
export function requireCell(declarations: Record<string, Cell>, name: string): Cell {
  const cell = declarations[name];
  if (!cell) {
    console.error(`error: no cell named "${name}"`);
    process.exit(1);
  }
  return cell;
}

/** The shared read pipeline: collect import edges, warn on blind exts, derive cell
 *  crossings. Every analysis command routes through this (one drift surface). `warn` lets
 *  health skip the stderr blind-warning — its report already covers it. */
export async function loadCrossings(ownership: Ownership, warn = true): Promise<{ edges: ImportEdge[]; crossings: Crossing[]; uncoveredExts: string[]; unresolved: UnresolvedImport[] }> {
  const { edges, uncoveredExts, unresolved, failures, ignoreBlindExts } = await collectImportEdges();
  assertNoImporterFailures(failures);
  if (warn) warnIfBlind(uncoveredExts, ignoreBlindExts);
  // Unresolved imports only matter for the partition: an unowned file's broken specifier
  // affects nothing until the file is owned. Filtering here keeps health/crossings info
  // sections actionable (stress test: 280 noise entries from unowned files).
  const ownedUnresolved = unresolved.filter((u) => owningCell(ownership, u.fromFile) !== undefined);
  return { edges, crossings: deriveCrossings(edges, ownership), uncoveredExts, unresolved: ownedUnresolved };
}

/** Importer failure → blind graph → any crossing verdict is unreliable. Fail loudly (see loadCrossings). */
function assertNoImporterFailures(failures: { importer: string; error: string }[]): void {
  if (failures.length === 0) return;
  const detail = failures.map((f) => `importer "${f.importer}" failed: ${f.error}`).join('; ');
  throw new Error(`${detail} — crossings data incomplete (${failures.map((f) => f.importer).join(', ')} edges missing); gate verdict unreliable.`);
}

/** `cells imports [--json]` — the raw file→file import graph: every resolved edge (same-cell
 *  included, unowned files included) + every unresolved specifier. Machine surface for
 *  external tooling (the oracle harness in cells_stress_test consumes it); the gate never
 *  reads it. */
export async function cmdImports(opts: { json?: boolean } = {}): Promise<void> {
  const { edges, unresolved, uncoveredExts, failures } = await collectImportEdges();
  assertNoImporterFailures(failures);
  if (!opts.json) {
    console.log(`${edges.length} import edge(s), ${unresolved.length} unresolved specifier(s)`);
    return;
  }
  process.stdout.write(JSON.stringify({ edges, unresolved, uncoveredExts }, null, 2) + '\n');
}
