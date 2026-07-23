import type { Crossing } from './crossings.js';

/**
 * Format the cell graph as a Mermaid flowchart (for HUMAN visualization — renders
 * natively in GitHub READMEs; the model reads `list`/`crossings` instead).
 * Dedupes file-level crossings to unique cell->cell edges. Pure.
 */
export function formatCellGraph(crossings: Crossing[]): string {
  const edges = new Set<string>();
  for (const c of crossings) edges.add(`${c.fromCell} --> ${c.toCell}`);
  const lines = ['flowchart LR'];
  for (const e of [...edges].sort()) lines.push(`  ${e}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Render the cell graph as an in-terminal ASCII tree (default — no external tool
 * needed). DFS from roots (cells nothing depends on); shared dependents are
 * marked ↩ and not re-expanded. Pure.
 */
export function formatCellGraphAscii(crossings: Crossing[]): string {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
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
  const start = roots.length > 0 ? roots : [...nodes].sort();
  const visited = new Set<string>();
  const lines: string[] = [];

  const emitSiblings = (siblings: string[], prefix: string): void => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      const last = i === siblings.length - 1;
      const connector = last ? '└── ' : '├── ';
      if (visited.has(node)) {
        lines.push(`${prefix}${connector}${node} ↩`);
        continue;
      }
      visited.add(node);
      lines.push(`${prefix}${connector}${node}`);
      emitSiblings(adj.get(node) ?? [], prefix + (last ? '    ' : '│   '));
    }
  };

  for (const root of start) {
    if (visited.has(root)) continue;
    visited.add(root);
    lines.push(root);
    emitSiblings(adj.get(root) ?? [], '');
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}
