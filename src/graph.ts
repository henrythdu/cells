import type { Crossing } from './crossings.js';

/**
 * Format the cell graph as a Mermaid flowchart. The flowchart is for human
 * visualization and renders directly in GitHub README files. A model reads `list` or
 * `crossings` instead.
 *
 * The function removes duplicate file-level crossings and keeps unique cell-to-cell
 * edges. Pure.
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
  // A cell with no crossing must still appear. An empty diagram would hide it. Both endpoints count.
  for (const n of [...nodes].sort()) if (!hasEdge.has(n)) lines.push(`  ${n}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Render the cell graph as an ASCII tree in the terminal. This is the default format and
 * does not need an external tool.
 *
 * The function walks the graph depth-first from the root cells. A root cell is a cell
 * that no other cell depends on. A dependent that an earlier branch already printed gets
 * a ↩ mark and is not expanded again. Pure.
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
  // This list is empty when the whole graph is cyclic. The sweep for isolated components below handles that case in the same way.
  const start = roots;
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const lines: string[] = [];

  const emitSiblings = (siblings: string[], prefix: string): void => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      const last = i === siblings.length - 1;
      const connector = last ? '└── ' : '├── ';
      if (visited.has(node)) {
        // The node is on the current stack when the edge is a back edge and part of a cycle. Otherwise the edge is a cross edge in a directed acyclic graph (a diamond).
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
  // The roots reach only the nodes that point to them. A cycle that no root path reaches
  // (an isolated component, or a component reachable only through another cycle) has no
  // start entry. The first loop ended without printing it, so the graph silently lost
  // components. The loop below starts at every node that is still unvisited.
  for (const node of [...nodes].sort()) {
    if (visited.has(node)) continue;
    emitRoot(node);
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
