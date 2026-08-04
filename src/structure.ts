import type { Crossing, CellMetrics } from './crossings.js';
import type { Cell } from './declaration.js';

/**
 * Structure governance — three Clean-Architecture principles as pure checks on
 * the crossing graph:
 *   - ADP (Acyclic Dependencies Principle): the cell graph must have no cycles.
 *   - Direction: edges should run toward the core (layer 0); an edge to a
 *     higher layer (core→peripheral) is a Dependency-Inversion smell.
 *   - SDP (Stable Dependencies Principle): edges should run toward stability
 *     (lower I); an edge from a stable cell to a less-stable one is a smell.
 * All are WARNINGS (exit 0). The IO/CLI layer supplies crossings + config.
 */

/** A cycle — the cells in one strongly-connected component (mutual dependency). */
export interface Cycle {
  cells: string[]; // sorted; size > 1
}

/** A ranked cut candidate inside a cycle — an internal cell-pair edge + how many files carry it. */
export interface CycleCutCandidate {
  fromCell: string;
  toCell: string;
  fileCount: number;
}

/**
 * Rank a cycle's internal cell-pair edges by file-crossing count (ascending). The thinnest edge
 * (fewest files) is the cheapest to decouple — the first place to look when breaking the cycle.
 * Not guaranteed to break the SCC on its own (a cycle may have redundant paths), but the
 * thinnest edges are where the coupling is weakest. Pure + deterministic.
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
 * Detect cycles in the cell graph via Tarjan's SCC.
 * A strongly-connected component of size > 1 is a cycle (self-loops are
 * impossible — deriveCrossings drops same-cell edges). Pure + deterministic
 * (cells sorted within each cycle; cycles sorted by first cell).
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

/** A direction violation — a higher-layer cell depending on a lower-layer one. */
export interface DirectionViolation {
  fromCell: string;
  fromLayer: number;
  toCell: string;
  toLayer: number;
}
/**
 * Check edge direction against each cell's numeric `layer` (0 = core/foundation;
 * higher = more peripheral). Dependencies must point TOWARD 0 (peripheral→core);
 * an edge to a HIGHER layer (core→peripheral) is the violation. Skips any edge
 * with a layerless endpoint. Dedupes multiple crossings between the same pair. Pure.
 */
export function checkDirection(crossings: Crossing[], declarations: Record<string, Cell>): DirectionViolation[] {
  const seen = new Set<string>();
  const out: DirectionViolation[] = [];
  for (const c of crossings) {
    const fromLayer = declarations[c.fromCell]?.layer;
    const toLayer = declarations[c.toCell]?.layer;
    if (fromLayer === undefined || toLayer === undefined) continue;
    if (fromLayer < toLayer) {
      const key = `${c.fromCell}->${c.toCell}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ fromCell: c.fromCell, fromLayer, toCell: c.toCell, toLayer });
    }
  }
  return out;
}

/** An SDP violation — a stable cell (lower I) depending on a less-stable one (higher I). */
export interface SdpViolation {
  fromCell: string;
  toCell: string;
  fromInstability: number;
  toInstability: number;
}

/**
 * SDP (Stable Dependencies Principle): edges should run toward stability — depend on
 * things at least as stable as yourself. A violation is an edge A→B where A is MORE
 * stable than B (I(A) < I(B)): the stable cell is coupled to a less-stable one, so
 * churn in the unstable cell can ripple into the stable one. Dedupes cell pairs
 * (multiple file-edges between the same pair count once). Sorted by gap (worst first).
 * Pure. Info-only — Cells surfaces the smell, doesn't enforce a fix.
 */
export function checkSDP(crossings: Crossing[], metrics: Record<string, CellMetrics>): SdpViolation[] {
  const seen = new Set<string>();
  const out: SdpViolation[] = [];
  for (const c of crossings) {
    const key = `${c.fromCell}->${c.toCell}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fromI = metrics[c.fromCell]?.instability;
    const toI = metrics[c.toCell]?.instability;
    if (fromI === undefined || toI === undefined) continue;
    if (fromI < toI) {
      out.push({ fromCell: c.fromCell, toCell: c.toCell, fromInstability: fromI, toInstability: toI });
    }
  }
  return out.sort((a, b) => b.toInstability - b.fromInstability - (a.toInstability - a.fromInstability) || a.fromCell.localeCompare(b.fromCell) || a.toCell.localeCompare(b.toCell));
}

/** Format SDP violations as an info-only report. Returns null when there are none. A long
 *  list (pandas: 100+ entries) dominates the structure output, so it's capped — the count
 *  and the first entries carry the signal; the tail of instability numbers is noise. Pure. */
export function formatSdpReport(violations: SdpViolation[]): string | null {
  if (violations.length === 0) return null;
  const cap = 20;
  const lines = ['SDP (Stable Dependencies Principle) — edges depending away from stability:'];
  for (const v of violations.slice(0, cap)) {
    lines.push(`  ${v.fromCell} (I=${v.fromInstability.toFixed(2)}) → ${v.toCell} (I=${v.toInstability.toFixed(2)})   depends on a less stable cell`);
  }
  if (violations.length > cap) lines.push(`  …and ${violations.length - cap} more (${violations.length} total)`);
  return lines.join('\n') + '\n';
}

/**
 * Render the layer model: cells grouped by tier (0 = core → higher = peripheral),
 * then the layerless ones. Returns '' when no cell declares a layer (nothing to
 * show). Pure.
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
  return lines.join('\n') + '\n';
}

/**
 * Format the structure report: ADP section + Direction section.
 * `layersConfigured` controls the Direction section's message when no layers
 * are set. Pure.
 */
export function formatStructureReport(cycles: Cycle[], violations: DirectionViolation[], layersConfigured: boolean, layerLabels: Record<number, string> = {}, crossings: Crossing[] = []): string {
  const fmt = (n: number): string => (layerLabels[n] ? `${layerLabels[n]} (${n})` : `${n}`);
  const lines: string[] = [];

  if (cycles.length === 0) {
    lines.push('ADP: acyclic — no circular dependencies.');
  } else {
    lines.push(`ADP: ${cycles.length} cycle(s):`);
    const cap = 20; // a 500-cell cycle (transformers) must not print 500 lines — the cut candidates carry the signal
    for (const cyc of cycles) {
      const overCap = cyc.cells.length > cap;
      const cells = overCap ? cyc.cells.slice(0, cap) : cyc.cells;
      lines.push(`  ⚠ ${cells.join(' ↔ ')}${overCap ? ` ↔ … ${cyc.cells.length - cap} more cell${cyc.cells.length - cap === 1 ? '' : 's'}` : ''}`);
      const cuts = cycleCutCandidates(cyc, crossings);
      if (cuts.length > 0)
        lines.push(
          `    cheapest edges (fewest files): ${cuts
            .slice(0, 3)
            .map((cu) => `${cu.fromCell}→${cu.toCell} (${cu.fileCount})`)
            .join(', ')}`,
        );
    }
  }

  if (!layersConfigured) {
    lines.push('Direction: (skipped — no cells declare a layer).');
  } else if (violations.length === 0) {
    lines.push('Direction: OK — no edges point to a higher layer.');
  } else {
    lines.push(`Direction: ${violations.length} violation(s):`);
    for (const v of violations) {
      lines.push(`  ⚠ ${v.fromCell} [${fmt(v.fromLayer)}] → ${v.toCell} [${fmt(v.toLayer)}] (→ higher layer)`);
    }
  }

  return lines.join('\n') + '\n';
}

/** The triage view of the structure report: one line per cycle (size + cheapest edges),
 *  a Direction count, and a collapsed SDP count — the overview for high-cycle repos
 *  (kafka 19, elasticsearch 126) where the full cycle chains dominate the output.
 *  Cycles sorted by size desc (the mega-cycle is the headline). Pure. */
export function formatStructureSummary(cycles: Cycle[], violations: DirectionViolation[], layersConfigured: boolean, crossings: Crossing[] = [], sdpCount = 0): string {
  const lines: string[] = [];

  if (cycles.length === 0) {
    lines.push('ADP: acyclic — no circular dependencies.');
  } else {
    const sorted = [...cycles].sort((a, b) => b.cells.length - a.cells.length);
    const totalCells = cycles.reduce((n, cyc) => n + cyc.cells.length, 0);
    lines.push(`ADP: ${cycles.length} cycle(s) — ${totalCells} cells total:`);
    for (const cyc of sorted) {
      const cuts = cycleCutCandidates(cyc, crossings);
      const edges =
        cuts.length > 0
          ? ` — cheapest: ${cuts
              .slice(0, 3)
              .map((cu) => `${cu.fromCell}→${cu.toCell} (${cu.fileCount})`)
              .join(', ')}`
          : '';
      lines.push(`  ⚠ ${cyc.cells.length} cell${cyc.cells.length === 1 ? '' : 's'}${edges}`);
    }
  }

  if (!layersConfigured) {
    lines.push('Direction: (skipped — no cells declare a layer).');
  } else if (violations.length === 0) {
    lines.push('Direction: OK — no edges point to a higher layer.');
  } else {
    lines.push(`Direction: ${violations.length} violation(s).`);
  }

  lines.push(`SDP: ${sdpCount} violation(s).`);
  return lines.join('\n') + '\n';
}

/** A cell's change-impact: who transitively depends on it, by hop distance. */
export interface Impact {
  cell: string;
  affected: { cell: string; distance: number }[]; // 1 = direct dependent
}

/**
 * Compute the blast radius of changing `cell`: every cell that transitively
 * depends on it, via reverse-reachability over the crossing graph (a→b means a
 * depends on b, so b's dependents are traced backward). `distance` is the min
 * hop count (1 = direct). Cycles are safe (visited set). Pure.
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
  while (queue.length > 0) {
    const cur = queue.shift()!;
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
 * Render a change-impact report: affected cells grouped by hop distance
 * (direct, then 2 hops, 3 hops...), or a leaf message when nothing depends on
 * the cell. Pure.
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
  return lines.join('\n') + '\n';
}

/**
 * Format layer suggestions: flag only cells that sit BELOW a declared dependency —
 * a real Direction risk (a cell importing something in a higher layer) — and
 * prescribe the minimal fix (raise to that dependency's layer). Same-layer and
 * higher-than-dependency assignments are Direction-valid, so they are NOT flagged.
 * Returns null when every layered cell satisfies Direction. Pure.
 */
export function formatLayerSuggestions(declarations: Record<string, Cell>): string | null {
  const mismatches: { name: string; current: number; suggested: number; reason: string }[] = [];
  for (const [name, cell] of Object.entries(declarations)) {
    if (cell.layer === undefined) continue;
    // deepest declared internal dependency
    let maxDepLayer = 0;
    let maxDep = '';
    for (const r of cell.requires) {
      const rLayer = declarations[r]?.layer;
      if (rLayer !== undefined && rLayer > maxDepLayer) {
        maxDepLayer = rLayer;
        maxDep = r;
      }
    }
    // Direction risk: this cell's layer is below one of its dependencies
    if (cell.layer < maxDepLayer) {
      mismatches.push({ name, current: cell.layer, suggested: maxDepLayer, reason: `depends on ${maxDep} at layer ${maxDepLayer}` });
    }
  }
  if (mismatches.length === 0) return null;

  const lines = ['Layer suggestions (cells below a dependency — Direction risk):'];
  for (const m of mismatches) {
    lines.push(`  ${m.name}: ${m.current} → ${m.suggested}  (${m.reason})`);
  }
  return lines.join('\n') + '\n';
}
