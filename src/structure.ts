import { CHANGE_COUPLING } from './config.js';
import type { CellMetrics, Crossing } from './crossings.js';
import type { Cell } from './declaration.js';
import type { Ownership } from './ownership.js';

/**
 * Structure governance. The module applies three Clean-Architecture principles to the
 * crossing graph as pure checks.
 *
 * - ADP (Acyclic Dependencies Principle): the cell graph must have no cycles.
 * - Direction: an edge should run toward the core (layer 0). An edge to a higher layer, from
 *   the core to a peripheral cell, is a Dependency-Inversion smell.
 * - SDP (Stable Dependencies Principle): an edge should run toward stability (a lower
 *   instability value). An edge from a stable cell to a less stable cell is a smell.
 *
 * The module also checks change coupling (ADR 0002): pairs of cells that change in the same
 * commits but have no crossing edge. Such a pair has a shared reason to change that imports
 * cannot show.
 *
 * All checks are WARNINGS (exit 0). The IO and CLI layers supply the crossings and the
 * configuration.
 */

/** One cycle: the cells in one strongly connected component (a mutual dependency). */
export interface Cycle {
  cells: string[]; // Sorted. The size is greater than 1.
}

/** A ranked cut candidate inside a cycle: an internal edge between two cells, and the number of files that carry it. */
export interface CycleCutCandidate {
  fromCell: string;
  toCell: string;
  fileCount: number;
}

/**
 * Rank the internal edges of one cycle by crossing count, from low to high.
 *
 * The thinnest edge is the cheapest edge to remove. Therefore it is the first candidate to
 * inspect when you break the cycle.
 *
 * This ranking does not guarantee that the edge breaks the strongly connected component. A
 * cycle can contain redundant paths. The thinnest edges show where the coupling is weakest.
 * Pure and deterministic.
 */
export function cycleCutCandidates(cycle: Cycle, crossings: Crossing[]): CycleCutCandidate[] {
  const members = new Set(cycle.cells);
  const byPair = new Map<string, CycleCutCandidate>();
  for (const c of crossings) {
    if (c.fromCell !== c.toCell && members.has(c.fromCell) && members.has(c.toCell)) {
      const key = `${c.fromCell}->${c.toCell}`;
      const entry = byPair.get(key) ?? { fromCell: c.fromCell, toCell: c.toCell, fileCount: 0 };
      entry.fileCount++;
      byPair.set(key, entry);
    }
  }
  return [...byPair.values()].sort((a, b) => a.fileCount - b.fileCount || a.fromCell.localeCompare(b.fromCell) || a.toCell.localeCompare(b.toCell));
}

/**
 * Detect the cycles in the cell graph with the Tarjan algorithm for strongly connected
 * components.
 *
 * A strongly connected component with a size greater than 1 is a cycle. A self-loop is
 * impossible, because `deriveCrossings` drops the edges inside one cell.
 *
 * Pure and deterministic: the cells in each cycle are sorted, and the cycles are sorted by
 * their first cell.
 */
export function detectCycles(crossings: Crossing[]): Cycle[] {
  const adj = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const c of crossings) {
    if (!adj.has(c.fromCell)) adj.set(c.fromCell, new Set());
    adj.get(c.fromCell)!.add(c.toCell);
    nodes.add(c.fromCell);
    nodes.add(c.toCell);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  };

  for (const v of nodes) {
    if (!indices.has(v)) strongconnect(v);
  }

  return sccs
    .filter((scc) => scc.length > 1)
    .map((scc) => ({ cells: [...scc].sort() }))
    .sort((x, y) => x.cells[0].localeCompare(y.cells[0]));
}

/** A direction violation: a cell in a lower layer depends on a cell in a higher layer, so the edge points away from the core. */
export interface DirectionViolation {
  fromCell: string;
  fromLayer: number;
  toCell: string;
  toLayer: number;
}

/**
 * Run `fn` once for each ordered cell pair in the crossings, including the self-edges (the
 * caller filters them). The seen set removes duplicates. `checkDirection` and `checkSDP` share
 * this function. Pure.
 */
function forEachCellPair(crossings: Crossing[], fn: (fromCell: string, toCell: string) => void): void {
  const seen = new Set<string>();
  for (const c of crossings) {
    const key = `${c.fromCell}->${c.toCell}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fn(c.fromCell, c.toCell);
  }
}

/**
 * Check the direction of each edge against the numeric `layer` of each cell. Layer 0 is the
 * core or foundation, and a higher value is more peripheral.
 *
 * A dependency must point TOWARD 0, from a peripheral cell to a core cell. An edge to a
 * HIGHER layer, from a core cell to a peripheral cell, is the violation.
 *
 * The function skips an edge when either endpoint has no layer. It removes duplicate
 * crossings between the same pair. Pure.
 */
export function checkDirection(crossings: Crossing[], declarations: Record<string, Cell>): DirectionViolation[] {
  const out: DirectionViolation[] = [];
  forEachCellPair(crossings, (fromCell, toCell) => {
    const fromLayer = declarations[fromCell]?.layer;
    const toLayer = declarations[toCell]?.layer;
    if (fromLayer === undefined || toLayer === undefined) return;
    if (fromLayer < toLayer) out.push({ fromCell, fromLayer, toCell, toLayer });
  });
  return out;
}

/** An SDP violation: a stable cell (lower instability) depends on a less stable cell (higher instability). */
export interface SdpViolation {
  fromCell: string;
  toCell: string;
  fromInstability: number;
  toInstability: number;
}

/**
 * SDP (Stable Dependencies Principle): an edge should run toward stability, so a cell should
 * depend on cells that are at least as stable as itself.
 *
 * A violation is an edge A -> B where A is MORE stable than B (I(A) < I(B)). The stable cell is
 * then coupled to a less stable cell, and change in the unstable cell can reach the stable
 * cell.
 *
 * The function removes duplicate cell pairs, so many file edges between one pair count once.
 * The result is sorted by the gap, worst first. Pure. Information only: Cells shows the smell
 * and does not enforce a fix.
 */
export function checkSDP(crossings: Crossing[], metrics: Record<string, CellMetrics>): SdpViolation[] {
  const out: SdpViolation[] = [];
  forEachCellPair(crossings, (fromCell, toCell) => {
    const fromI = metrics[fromCell]?.instability;
    const toI = metrics[toCell]?.instability;
    if (fromI === undefined || toI === undefined) return;
    if (fromI < toI) {
      out.push({ fromCell, toCell, fromInstability: fromI, toInstability: toI });
    }
  });
  return out.sort((a, b) => {
    const gapA = a.toInstability - a.fromInstability;
    const gapB = b.toInstability - b.fromInstability;
    return gapB - gapA || a.fromCell.localeCompare(b.fromCell) || a.toCell.localeCompare(b.toCell);
  });
}

/** Limit a rendered list to the first `cap` items, then add an "…and N more (M total)" tail. Pure. */
function capped<T>(items: T[], cap = 20): { shown: T[]; tail: string } {
  const shown = items.slice(0, cap);
  const tail = items.length > cap ? `  …and ${items.length - cap} more (${items.length} total)` : '';
  return { shown, tail };
}

/**
 * Format the SDP violations as an information-only report. The function returns null when
 * there are no violations.
 *
 * A long list (100 or more entries in a large repository) dominates the structure output, so
 * the report is capped. The count and the first entries carry the signal, and the tail of
 * instability numbers is noise. Pure.
 */
export function formatSdpReport(violations: SdpViolation[]): string | null {
  if (violations.length === 0) return null;
  const lines = ['SDP (Stable Dependencies Principle) — edges depending away from stability:'];
  const { shown, tail } = capped(violations);
  for (const v of shown) {
    lines.push(`  ${v.fromCell} (I=${v.fromInstability.toFixed(2)}) → ${v.toCell} (I=${v.toInstability.toFixed(2)})   depends on a less stable cell`);
  }
  if (tail) lines.push(tail);
  return `${lines.join('\n')}\n`;
}

/**
 * Render the layer model: the cells grouped by tier (0 is the core and a higher value is more
 * peripheral), then the cells with no layer.
 *
 * The function returns '' when no cell declares a layer, because there is nothing to show.
 * Pure.
 */
export function formatLayerOverview(declarations: Record<string, Cell>, layerLabels: Record<number, string> = {}): string {
  const byLayer = new Map<number, string[]>();
  const layerless: string[] = [];
  for (const [name, cell] of Object.entries(declarations)) {
    if (cell.layer === undefined) {
      layerless.push(name);
    } else {
      const arr = byLayer.get(cell.layer) ?? [];
      arr.push(name);
      byLayer.set(cell.layer, arr);
    }
  }
  if (byLayer.size === 0) return '';

  const lines: string[] = ['Layers (0 = core; higher = peripheral):'];
  for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
    const lbl = layerLabels[layer] ? ` (${layerLabels[layer]})` : '';
    lines.push(`  ${layer}${lbl}: ${[...byLayer.get(layer)!].sort().join(', ')}`);
  }
  if (layerless.length > 0) lines.push(`  — (layerless): ${layerless.sort().join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/** Format the top cycle-cut edges for a structure report. Pure. */
function cycleCutLabel(cycle: Cycle, crossings: Crossing[], prefix: string): string {
  const cuts = cycleCutCandidates(cycle, crossings);
  if (cuts.length === 0) return '';
  return `${prefix}${cuts
    .slice(0, 3)
    .map((cu) => `${cu.fromCell}→${cu.toCell} (${cu.fileCount})`)
    .join(', ')}`;
}

/**
 * The shared Direction section: skipped, OK, count, or detail. The full report lists each
 * violation, and the summary shows the count. Pure.
 */
function directionLines(violations: DirectionViolation[], layersConfigured: boolean, detailed: boolean, fmt: (n: number) => string = (n) => `${n}`): string[] {
  if (!layersConfigured) return ['Direction: (skipped — no cells declare a layer).'];
  if (violations.length === 0) return ['Direction: OK — no edges point to a higher layer.'];
  if (!detailed) return [`Direction: ${violations.length} violation(s).`];
  return [`Direction: ${violations.length} violation(s):`, ...violations.map((v) => `  ⚠ ${v.fromCell} [${fmt(v.fromLayer)}] → ${v.toCell} [${fmt(v.toLayer)}] (→ higher layer)`)];
}

/**
 * Format the structure report: the ADP section and the Direction section. `layersConfigured`
 * selects the message of the Direction section when no cell has a layer. Pure.
 */
export function formatStructureReport(cycles: Cycle[], violations: DirectionViolation[], layersConfigured: boolean, layerLabels: Record<number, string> = {}, crossings: Crossing[] = []): string {
  const fmt = (n: number): string => (layerLabels[n] ? `${layerLabels[n]} (${n})` : `${n}`);
  const lines: string[] = [];

  if (cycles.length === 0) {
    lines.push('ADP: acyclic — no circular dependencies.');
  } else {
    lines.push(`ADP: ${cycles.length} cycle(s):`);
    const cap = 20; // A cycle of 500 cells in a large repository must not print 500 lines. The cut candidates carry the signal.
    for (const cyc of cycles) {
      const overCap = cyc.cells.length > cap;
      const cells = overCap ? cyc.cells.slice(0, cap) : cyc.cells;
      lines.push(`  ⚠ ${cells.join(' ↔ ')}${overCap ? ` ↔ … ${cyc.cells.length - cap} more cell${cyc.cells.length - cap === 1 ? '' : 's'}` : ''}`);
      const cutLabel = cycleCutLabel(cyc, crossings, '    cheapest edges (fewest files): ');
      if (cutLabel) lines.push(cutLabel);
    }
  }

  lines.push(...directionLines(violations, layersConfigured, true, fmt));

  return `${lines.join('\n')}\n`;
}

/**
 * The triage view of the structure report: one line for each cycle (size and cheapest edges),
 * a Direction count, and one SDP count. This is the overview for a repository with many cycles
 * (large monorepos have 100 or more), where the full cycle chains dominate the output. The
 * cycles are sorted by size, from large to small, because the largest cycle is the headline.
 * Pure.
 */
export function formatStructureSummary(cycles: Cycle[], violations: DirectionViolation[], layersConfigured: boolean, crossings: Crossing[] = [], sdpCount = 0, coupling?: { unexplained: number; total: number }): string {
  const lines: string[] = [];

  if (cycles.length === 0) {
    lines.push('ADP: acyclic — no circular dependencies.');
  } else {
    const sorted = [...cycles].sort((a, b) => b.cells.length - a.cells.length);
    const totalCells = cycles.reduce((n, cyc) => n + cyc.cells.length, 0);
    lines.push(`ADP: ${cycles.length} cycle(s) — ${totalCells} cells total:`);
    for (const cyc of sorted) {
      const edges = cycleCutLabel(cyc, crossings, ' — cheapest: ');
      lines.push(`  ⚠ ${cyc.cells.length} cell${cyc.cells.length === 1 ? '' : 's'}${edges}`);
    }
  }

  lines.push(...directionLines(violations, layersConfigured, false));

  lines.push(`SDP: ${sdpCount} violation(s).`);
  if (coupling && coupling.total > 0) {
    lines.push(`Change coupling: ${coupling.unexplained} unexplained pair(s), ${coupling.total} total.`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A change-coupling finding for one pair of cells (ADR 0002): how often the two cells change
 * in the same commits in git history, and whether a crossing edge explains it.
 *
 * `count` is the number of commits that touch both cells. `union` is the number of commits that
 * touch either cell. `jaccard` is count divided by union. `explained` is true when a crossing
 * edge exists between the pair, which is dependency ripple and the null hypothesis.
 */
interface CoupledPair {
  a: string;
  b: string;
  count: number;
  union: number;
  jaccard: number;
  explained: boolean;
  /**
   * Up to 5 files that changed together in the commits of this pair, from either cell. These
   * are the files that a model should inspect. Sorted and capped when the object is built.
   */
  sampleFiles: string[];
}

/**
 * The complete change-coupling result: the pairs that remain, and the commit window that the
 * count used. The window becomes smaller when the history is short, which changes the
 * denominator of the rate.
 */
export interface CouplingResult {
  pairs: CoupledPair[];
  window: number;
}

/** Test whether `file` is a lockfile or a generated artifact. Such a file changes with everything, so it is noise. */
function isCouplingNoise(file: string): boolean {
  if (CHANGE_COUPLING.lockfiles.some((l) => file === l || file.endsWith(`/${l}`))) return true;
  return CHANGE_COUPLING.generated.some((g) => file.endsWith(g));
}

/**
 * Classify the co-change of cell pairs from git history and compare it with the crossing
 * graph.
 *
 * For each commit, after the filters, every touched cell pair gets one co-change. The Jaccard
 * rate is the count divided by the union of the per-cell touch counts. A pair below the floor
 * or below the threshold is dropped.
 *
 * `explained` is true when a crossing edge exists between the pair, which is dependency ripple
 * and normal. An unexplained pair is the smell: the two cells have a shared reason to change
 * and no structural channel. The membrane split is then wrong, or a hidden channel, such as a
 * shared config or schema, needs a declaration.
 *
 * The filters are commit hygiene rules from ADR 0002. The function excludes a wide commit
 * (more than 30% of the owned files, because a mass reformat or rename would dominate every
 * union) and a commit whose only owned files are lockfiles or generated files. The exclusion
 * occurs BEFORE the pair count, so the window counts only the commits that carry signal.
 *
 * Pure. The git access lives in `diff.ts`. The commit shape is structural and does not use a
 * type import: an import of `CommitFiles` from `diff.js` would add a layer-6 edge to this
 * layer-3 cell, which is a Direction violation.
 */
export function classifyChangeCoupling(commits: { hash: string; files: string[] }[], ownership: Ownership, crossings: Crossing[]): CouplingResult {
  const fileToCell = new Map<string, string>();
  let ownedTotal = 0;
  for (const [cell, files] of Object.entries(ownership)) {
    for (const f of files) {
      fileToCell.set(f, cell);
      ownedTotal++;
    }
  }
  if (ownedTotal === 0) return { pairs: [], window: 0 };

  const edgeSet = new Set<string>();
  for (const c of crossings) {
    if (c.fromCell !== c.toCell) {
      edgeSet.add(`${c.fromCell}|${c.toCell}`);
      edgeSet.add(`${c.toCell}|${c.fromCell}`);
    }
  }

  const touches = new Map<string, number>(); // The number of commits that touch each cell.
  const coChange = new Map<string, number>(); // "a|b" (a < b) -> the number of commits that touch both cells
  const coChangeFiles = new Map<string, Set<string>>(); // "a|b" -> the files that changed together (from either cell)
  let window = 0;
  for (const commit of commits) {
    const cells = new Set<string>();
    let ownedInCommit = 0;
    let noiseOnly = true;
    for (const f of commit.files) {
      const cell = fileToCell.get(f);
      if (cell === undefined) continue;
      ownedInCommit++;
      cells.add(cell);
      if (!isCouplingNoise(f)) noiseOnly = false;
    }
    if (cells.size === 0) continue;
    if (ownedInCommit > CHANGE_COUPLING.wideCommitMin && ownedInCommit / ownedTotal > CHANGE_COUPLING.wideCommitRatio) continue; // A mass refactor or format pass.
    if (noiseOnly) continue; // A commit with only lockfiles or generated files (a dependency bump).
    window++;
    for (const cell of cells) touches.set(cell, (touches.get(cell) ?? 0) + 1);
    const sorted = [...cells].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}|${sorted[j]}`;
        coChange.set(key, (coChange.get(key) ?? 0) + 1);
        // Add the files that changed together, once for each pair and each commit (from either cell).
        const files = coChangeFiles.get(key) ?? new Set<string>();
        for (const f of commit.files) {
          const cell = fileToCell.get(f);
          if (cell === sorted[i] || cell === sorted[j]) files.add(f);
        }
        coChangeFiles.set(key, files);
      }
    }
  }

  const pairs: CoupledPair[] = [];
  for (const [key, count] of coChange) {
    if (count < CHANGE_COUPLING.minCoChanges) continue;
    const [a, b] = key.split('|');
    const union = (touches.get(a) ?? 0) + (touches.get(b) ?? 0) - count;
    if (union <= 0) continue;
    const jaccard = count / union;
    if (jaccard < CHANGE_COUPLING.jaccard) continue;
    pairs.push({ a, b, count, union, jaccard, explained: edgeSet.has(key), sampleFiles: [...(coChangeFiles.get(key) ?? [])].sort().slice(0, 5) });
  }
  // Unexplained pairs (the smell) first, then by co-change count from high to low, then by
  // name. This is stable and deterministic: window noise cannot change the order beyond the
  // primary keys.
  pairs.sort((x, y) => Number(x.explained) - Number(y.explained) || y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return { pairs, window };
}

/**
 * Format the change-coupled pairs as an advisory report. The function returns null when the
 * result is clean (no pair above the threshold), so the section disappears, as in
 * `formatSdpReport`.
 *
 * The report is capped like SDP: a list of 100 pairs is noise, and the count and the worst
 * entries carry the signal. Pure.
 */
export function formatChangeCouplingReport(result: CouplingResult): string | null {
  if (result.pairs.length === 0) return null;
  const lines = [
    `Change-coupled cells (${result.window} analyzed commits; co-change >= ${CHANGE_COUPLING.minCoChanges} commits and >= ${Math.round(CHANGE_COUPLING.jaccard * 100)}% of shared history):`,
    `  resolutions: merge the cells, re-draw the membrane, declare the hidden channel as requires, or accept (test doubles and config legitimately couple).`,
  ];
  const { shown, tail } = capped(result.pairs);
  for (const p of shown) {
    const mark = p.explained ? '  ' : '  ⚠ ';
    const why = p.explained ? 'explained — has import edge' : 'unexplained — no import edge';
    lines.push(`${mark}${p.a} ↔ ${p.b}   ${why} (${p.count}/${result.window}, ${Math.round(p.jaccard * 100)}%)`);
  }
  if (tail) lines.push(tail);
  return `${lines.join('\n')}\n`;
}

/** The change impact of a cell: which cells depend on it, transitively, with the hop distance. */
export interface Impact {
  cell: string;
  affected: { cell: string; distance: number }[]; // A value of 1 is a direct dependent.
}

/**
 * Compute the blast radius of a change to `cell`: every cell that depends on it,
 * transitively.
 *
 * The function uses reverse reachability over the crossing graph. An edge a -> b means that a
 * depends on b, so the function traces the dependents of b backward. `distance` is the minimum
 * number of hops (1 is a direct dependent). A cycle is safe, because the function keeps a
 * visited set. Pure.
 */
export function computeImpact(crossings: Crossing[], cell: string): Impact {
  const dependents = new Map<string, Set<string>>();
  for (const c of crossings) {
    const arr = dependents.get(c.toCell) ?? new Set<string>();
    arr.add(c.fromCell);
    dependents.set(c.toCell, arr);
  }

  const dist = new Map<string, number>([[cell, 0]]);
  const queue: string[] = [cell];
  let head = 0; // Use an index pointer and not shift(). Dequeue is then O(1), which matters on a large graph.
  while (head < queue.length) {
    const cur = queue[head++]!;
    for (const dep of dependents.get(cur) ?? []) {
      if (!dist.has(dep)) {
        dist.set(dep, (dist.get(cur) ?? 0) + 1);
        queue.push(dep);
      }
    }
  }

  const affected = [...dist.entries()]
    .filter(([c]) => c !== cell)
    .map(([c, d]) => ({ cell: c, distance: d }))
    .sort((a, b) => a.distance - b.distance || a.cell.localeCompare(b.cell));
  return { cell, affected };
}

/**
 * Render the change-impact report: the affected cells grouped by hop distance (direct, then 2
 * hops, then 3 hops, and so on), or a leaf message when no cell depends on the cell. Pure.
 */
export function formatImpactReport(impact: Impact): string {
  if (impact.affected.length === 0) {
    return `${impact.cell} is a leaf — no import dependents (static view; hidden callers like reflection, registries, and entry points are invisible). Safe to change — verify before deleting.\n`;
  }
  const byDistance = new Map<number, string[]>();
  for (const a of impact.affected) {
    const arr = byDistance.get(a.distance) ?? [];
    arr.push(a.cell);
    byDistance.set(a.distance, arr);
  }
  const lines = [`Impact: changing ${impact.cell} affects ${impact.affected.length} cell(s):`];
  for (const d of [...byDistance.keys()].sort((a, b) => a - b)) {
    const label = d === 1 ? 'direct' : `${d} hops`;
    lines.push(`  ${label}: ${byDistance.get(d)!.sort().join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Format the layer suggestions. The function reports only a cell that sits BELOW a declared
 * dependency, which is a real Direction risk because the cell imports a cell in a higher
 * layer. The function gives the minimal repair: raise the cell to the layer of that
 * dependency.
 *
 * An assignment in the same layer or above its dependency satisfies Direction, so the function
 * does not report it.
 *
 * The function returns null when every cell with a layer satisfies Direction. Pure.
 */
export function formatLayerSuggestions(declarations: Record<string, Cell>): string | null {
  const mismatches: { name: string; current: number; suggested: number; reason: string }[] = [];
  for (const [name, cell] of Object.entries(declarations)) {
    if (cell.layer === undefined) continue;
    // The deepest declared internal dependency.
    let maxDepLayer = 0;
    let maxDep = '';
    for (const r of cell.requires) {
      const rLayer = declarations[r]?.layer;
      if (rLayer !== undefined && rLayer > maxDepLayer) {
        maxDepLayer = rLayer;
        maxDep = r;
      }
    }
    // Direction risk: the layer of this cell is below one of its dependencies.
    if (cell.layer < maxDepLayer) {
      mismatches.push({ name, current: cell.layer, suggested: maxDepLayer, reason: `depends on ${maxDep} at layer ${maxDepLayer}` });
    }
  }
  if (mismatches.length === 0) return null;

  const lines = ['Layer suggestions (cells below a dependency — Direction risk):'];
  for (const m of mismatches) {
    lines.push(`  ${m.name}: ${m.current} → ${m.suggested}  (${m.reason})`);
  }
  return `${lines.join('\n')}\n`;
}
