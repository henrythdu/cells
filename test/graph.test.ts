import { describe, it, expect } from 'vitest';
import { formatCellGraph, formatCellGraphAscii } from '../src/graph.js';
import type { Crossing } from '../src/crossings.js';

const e = (fromCell: string, toCell: string): Crossing => ({
  fromCell, toCell, fromFile: 'f', toFile: 't', import: 'i',
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

  it('renders multiple roots', () => {
    expect(formatCellGraphAscii([e('a', 'b'), e('c', 'd')])).toBe('a\n└── b\nc\n└── d\n');
  });

  it('returns empty for no crossings', () => {
    expect(formatCellGraphAscii([])).toBe('');
  });
});
