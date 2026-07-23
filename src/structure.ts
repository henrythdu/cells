import type { Crossing } from './crossings.js';
import type { Cell } from './declaration.js';

/**
 * Structure governance — two Clean-Architecture principles as pure checks on
 * the crossing graph:
 *   - ADP (Acyclic Dependencies Principle): the cell graph must have no cycles.
 *   - Direction: edges should run toward the core (layer 0); an edge to a
 *     higher layer (core→peripheral) is a Dependency-Inversion smell.
 * Both are WARNINGS (exit 0). The IO/CLI layer supplies crossings + config.
 */

/** A cycle — the cells in one strongly-connected component (mutual dependency). */
export interface Cycle {
  cells: string[]; // sorted; size > 1
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
export function checkDirection(
  crossings: Crossing[],
  declarations: Record<string, Cell>,
): DirectionViolation[] {
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

/**
 * Render the layer model: cells grouped by tier (0 = core → higher = peripheral),
 * then the layerless ones. Returns '' when no cell declares a layer (nothing to
 * show). Pure.
 */
export function formatLayerOverview(
  declarations: Record<string, Cell>,
  layerLabels: Record<number, string> = {},
): string {
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
export function formatStructureReport(
  cycles: Cycle[],
  violations: DirectionViolation[],
  layersConfigured: boolean,
  layerLabels: Record<number, string> = {},
): string {
  const fmt = (n: number): string => (layerLabels[n] ? `${layerLabels[n]} (${n})` : `${n}`);
  const lines: string[] = [];

  if (cycles.length === 0) {
    lines.push('ADP: acyclic — no circular dependencies.');
  } else {
    lines.push(`ADP: ${cycles.length} cycle(s):`);
    for (const cyc of cycles) lines.push(`  ⚠ ${cyc.cells.join(' ↔ ')}`);
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
    return `${impact.cell} is a leaf — nothing depends on it (safe to change).\n`;
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
