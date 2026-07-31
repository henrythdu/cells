import { describe, it, expect } from 'vitest';
import { formatCellGraph, formatCellGraphAscii } from '../src/graph.js';
import type { Crossing } from '../src/crossings.js';

const e = (fromCell: string, toCell: string): Crossing => ({
  fromCell,
  toCell,
  fromFile: 'f',
  toFile: 't',
  import: 'i',
});

describe('formatCellGraph', () => {
  it('emits a Mermaid flowchart of unique cell->cell edges', () => {
    const crossings: Crossing[] = [
      { fromCell: 'cli', toCell: 'io', fromFile: 'f', toFile: 't', import: 'i' },
      { fromCell: 'cli', toCell: 'io', fromFile: 'g', toFile: 'u', import: 'j' }, // dup pair -> one edge
      { fromCell: 'io', toCell: 'config', fromFile: 'f', toFile: 't', import: 'i' },
    ];
    const out = formatCellGraph(crossings);
    expect(out).toContain('flowchart LR');
    expect(out).toContain('cli --> io');
    expect(out).toContain('io --> config');
    expect(out.split('cli --> io').length).toBe(2); // deduped: appears exactly once
  });

  it('handles empty crossings', () => {
    expect(formatCellGraph([])).toBe('flowchart LR\n');
  });

  it('renders isolated cells when no edges exist (no empty diagram)', () => {
    const out = formatCellGraph([], ['alpha', 'beta']);
    expect(out).toContain('  alpha');
    expect(out).toContain('  beta');
  });

  it('does not duplicate a cell that already has edges', () => {
    const out = formatCellGraph([e('cli', 'io')], ['cli', 'io', 'orphan']);
    expect(out.split('cli --> io').length).toBe(2); // the edge, once
    expect(out).not.toMatch(/\n {2}cli\n/); // no extra bare 'cli' node line
    expect(out).toContain('  orphan');
  });
});

describe('formatCellGraphAscii', () => {
  it('renders a chain as a tree (last-child connectors)', () => {
    expect(formatCellGraphAscii([e('a', 'b'), e('b', 'c')])).toBe('a\n└── b\n    └── c\n');
  });

  it('renders multiple children with ├── / └──', () => {
    expect(formatCellGraphAscii([e('a', 'b'), e('a', 'c')])).toBe('a\n├── b\n└── c\n');
  });

  it('marks shared dependents with ↩ (dedup, no re-expansion)', () => {
    const out = formatCellGraphAscii([e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')]);
    expect(out).toBe('a\n├── b\n│   └── d\n└── c\n    └── d ↩\n');
  });

  it('marks a back-edge to a node on the DFS stack as ↻ cycle (not ↩)', () => {
    // a→b→a is a 2-cycle; the second a is on the stack → ↻ cycle, not ↩
    const out = formatCellGraphAscii([e('a', 'b'), e('b', 'a')]);
    expect(out).toContain('a ↻ cycle');
    expect(out).not.toContain('a ↩');
  });

  it('renders multiple roots', () => {
    expect(formatCellGraphAscii([e('a', 'b'), e('c', 'd')])).toBe('a\n└── b\nc\n└── d\n');
  });

  it('renders isolated cells with no edges (turborepo: 2 cells, 0 edges)', () => {
    expect(formatCellGraphAscii([], ['alpha', 'beta'])).toBe('alpha\nbeta\n');
  });

  it('returns empty for no crossings', () => {
    expect(formatCellGraphAscii([])).toBe('');
  });
});
