import type { Crossing } from './crossings.js';

/**
 * Format the cell graph as a Mermaid flowchart (for HUMAN visualization — renders
 * natively in GitHub READMEs; the model reads `list`/`crossings` instead).
 * Dedupes file-level crossings to unique cell->cell edges. Pure.
 */
export function formatCellGraph(crossings: Crossing[], allCells: string[] = []): string {
  const edges = new Set<string>();
  const nodes = new Set(allCells);
  const hasEdge = new Set<string>();
  for (const c of crossings) {
    edges.add(`${c.fromCell} --> ${c.toCell}`);
    nodes.add(c.fromCell);
    nodes.add(c.toCell);
    hasEdge.add(c.fromCell);
    hasEdge.add(c.toCell);
  }
  const lines = ['flowchart LR'];
  for (const e of [...edges].sort()) lines.push(`  ${e}`);
  // cells with no crossings still render — an empty diagram hides them (both endpoints count)
  for (const n of [...nodes].sort()) if (!hasEdge.has(n)) lines.push(`  ${n}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Render the cell graph as an in-terminal ASCII tree (default — no external tool
 * needed). DFS from roots (cells nothing depends on); shared dependents are
 * marked ↩ and not re-expanded. Pure.
 */
export function formatCellGraphAscii(crossings: Crossing[], allCells: string[] = []): string {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>(allCells);
  const incoming = new Set<string>();
  for (const c of crossings) {
    nodes.add(c.fromCell);
    nodes.add(c.toCell);
    incoming.add(c.toCell);
    const deps = adj.get(c.fromCell) ?? [];
    adj.set(c.fromCell, deps);
    if (!deps.includes(c.toCell)) deps.push(c.toCell);
  }
  for (const deps of adj.values()) deps.sort();

  const roots = [...nodes].filter((n) => !incoming.has(n)).sort();
  const start = roots; // empty when fully cyclic — the isolated-SCC sweep below covers that case identically
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const lines: string[] = [];

  const emitSiblings = (siblings: string[], prefix: string): void => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      const last = i === siblings.length - 1;
      const connector = last ? '└── ' : '├── ';
      if (visited.has(node)) {
        // on the current DFS stack = a back-edge = part of a cycle; else a DAG cross-edge (diamond)
        lines.push(`${prefix}${connector}${node} ${onStack.has(node) ? '↻ cycle' : '↩'}`);
        continue;
      }
      visited.add(node);
      onStack.add(node);
      lines.push(`${prefix}${connector}${node}`);
      emitSiblings(adj.get(node) ?? [], prefix + (last ? '    ' : '│   '));
      onStack.delete(node);
    }
  };

  const emitRoot = (node: string): void => {
    visited.add(node);
    onStack.add(node);
    lines.push(node);
    emitSiblings(adj.get(node) ?? [], '');
    onStack.delete(node);
  };
  for (const root of start) {
    if (visited.has(root)) continue;
    emitRoot(root);
  }
  // Roots only reach what points at them. A cycle with no root path into it (an
  // isolated SCC, or reachable only through another cycle) never got a start entry and the
  // old loop ended without emitting it — the graph silently lost components. Sweep every
  // still-unvisited node as a start of its own.
  for (const node of [...nodes].sort()) {
    if (visited.has(node)) continue;
    emitRoot(node);
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
