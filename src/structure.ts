import type { Crossing } from './crossings.js';
import type { Cell } from './declaration.js';

/**
 * Structure governance — two Clean-Architecture principles as pure checks on
 * the crossing graph:
 *   - ADP (Acyclic Dependencies Principle): the cell graph must have no cycles.
 *   - Direction: edges should run low→high (details plug into policy); a
 *     high→low edge is a Dependency-Inversion smell.
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

/** A direction violation — a high-level cell depending on a lower-level one. */
export interface DirectionViolation {
  fromCell: string;
  fromLayer: string;
  toCell: string;
  toLayer: string;
}

/**
 * Check edge direction against a layer order (index 0 = lowest).
 * Flags edges where fromCell's layer ranks HIGHER than toCell's (high→low).
 * Skips: untagged cells, layers not in the order, and the empty-order case
 * (no layers configured). Dedupes multiple crossings between the same pair.
 * Pure.
 */
export function checkDirection(
  crossings: Crossing[],
  declarations: Record<string, Cell>,
  layerOrder: string[],
): DirectionViolation[] {
  if (layerOrder.length === 0) return [];
  const rank = (layer: string | undefined): number | undefined => {
    if (!layer) return undefined;
    const i = layerOrder.indexOf(layer);
    return i === -1 ? undefined : i;
  };

  const seen = new Set<string>();
  const out: DirectionViolation[] = [];
  for (const c of crossings) {
    const fromLayer = declarations[c.fromCell]?.layer;
    const toLayer = declarations[c.toCell]?.layer;
    const fromRank = rank(fromLayer);
    const toRank = rank(toLayer);
    if (fromRank === undefined || toRank === undefined) continue;
    if (fromRank > toRank) {
      const key = `${c.fromCell}->${c.toCell}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        fromCell: c.fromCell,
        fromLayer: fromLayer!,
        toCell: c.toCell,
        toLayer: toLayer!,
      });
    }
  }
  return out;
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
): string {
  const lines: string[] = [];

  if (cycles.length === 0) {
    lines.push('ADP: acyclic — no circular dependencies.');
  } else {
    lines.push(`ADP: ${cycles.length} cycle(s):`);
    for (const cyc of cycles) lines.push(`  ⚠ ${cyc.cells.join(' ↔ ')}`);
  }

  if (!layersConfigured) {
    lines.push('Direction: (skipped — no layers configured in .cells/config.toml).');
  } else if (violations.length === 0) {
    lines.push('Direction: OK — no high→low edges.');
  } else {
    lines.push(`Direction: ${violations.length} violation(s):`);
    for (const v of violations) {
      lines.push(`  ⚠ ${v.fromCell} [${v.fromLayer}] → ${v.toCell} [${v.toLayer}] (high→low)`);
    }
  }

  return lines.join('\n') + '\n';
}
