import { describe, it, expect } from 'vitest';
import { formatCellList, formatCellShow, formatSizeReport, formatCellGraph, formatCellGraphAscii, type CellSize } from '../src/view.js';
import type { Cell } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';
import type { CellMetrics, Crossing } from '../src/crossings.js';

const decls: Record<string, Cell> = {
  declaration: { name: 'declaration', purpose: 'parse', provides: ['parseCell'], requires: [] },
  cli: { name: 'cli', purpose: 'wire', provides: ['main'], requires: ['declaration'] },
};
const ownership: Ownership = {
  declaration: ['src/declaration.ts'],
  cli: ['src/cli.ts', 'test/cli.test.ts'],
};
const sizes: Record<string, CellSize> = {
  declaration: { files: 1, chars: 400, tokens: 100 },
  cli: { files: 2, chars: 800, tokens: 200 },
};
const listMetrics: Record<string, CellMetrics> = {
  declaration: { fanIn: 1, fanOut: 0, instability: 0 }, // ←cli
  cli: { fanIn: 0, fanOut: 1, instability: 1 }, // →declaration
};

describe('formatCellList', () => {
  it('lists each cell with file count, size, its requires, and fan-in/fan-out', () => {
    const out = formatCellList(decls, ownership, sizes, listMetrics, []);
    expect(out).toContain('declaration');
    expect(out).toContain('cli');
    expect(out).toMatch(/cli[\s\S]*2/); // cli owns 2 files
    expect(out).toMatch(/cli[\s\S]*declaration/); // cli requires declaration
    expect(out).toContain('1/0'); // declaration: fan-in 1 / fan-out 0
    expect(out).toContain('0/1'); // cli: fan-in 0 / fan-out 1
  });

  it('reports the orphan count and lists unowned files', () => {
    const out = formatCellList(decls, ownership, sizes, listMetrics, ['src/orphan.ts', 'examples/demo.ts']);
    expect(out).toContain('2 orphan');
    expect(out).toContain('src/orphan.ts');
    expect(out).toContain('examples/demo.ts');
  });

  it('reports zero orphans cleanly', () => {
    expect(formatCellList(decls, ownership, sizes, listMetrics, [])).toContain('0 orphan');
  });
});

describe('formatCellShow', () => {
  const cell: Cell = {
    name: 'validate',
    purpose: 'check partition integrity',
    provides: ['validatePartition'],
    requires: ['ownership', 'declaration'],
  };
  const owned = ['src/validate.ts', 'test/validate.test.ts'];
  const out: Crossing[] = [
    { fromCell: 'validate', toCell: 'ownership', fromFile: 'src/validate.ts', toFile: 'src/ownership.ts', import: './ownership' },
    { fromCell: 'validate', toCell: 'declaration', fromFile: 'src/validate.ts', toFile: 'src/declaration.ts', import: './declaration' },
  ];
  const inc: Crossing[] = [
    { fromCell: 'cli', toCell: 'validate', fromFile: 'src/cli.ts', toFile: 'src/validate.ts', import: './validate' },
  ];
  const size: CellSize = { files: 2, chars: 640, tokens: 160 };
  // out: validate → {ownership, declaration} (fanOut 2); in: cli → validate (fanIn 1) → I = 2/3 ≈ 0.67
  const metrics: CellMetrics = { fanIn: 1, fanOut: 2, instability: 2 / 3 };
  const out2 = formatCellShow(cell, owned, out, inc, size, metrics);

  it('shows the declaration (purpose, provides, requires)', () => {
    expect(out2).toContain('cell: validate');
    expect(out2).toContain('check partition integrity');
    expect(out2).toContain('validatePartition');
    expect(out2).toContain('ownership');
    expect(out2).toContain('declaration');
  });

  it('lists owned files', () => {
    expect(out2).toContain('src/validate.ts');
    expect(out2).toContain('test/validate.test.ts');
  });

  it('lists imports (out) and imported-by (in) crossings', () => {
    // out: validate → ownership, with the file edge
    expect(out2).toMatch(/→ ownership[\s\S]*src\/validate\.ts → src\/ownership\.ts/);
    // in: cli → validate
    expect(out2).toMatch(/← cli[\s\S]*src\/cli\.ts → src\/validate\.ts/);
  });

  it('shows dependency metrics (fan-in/fan-out/instability)', () => {
    expect(out2).toContain('fan-in 1');
    expect(out2).toContain('fan-out 2');
    expect(out2).toContain('instability 0.67');
  });
});

describe('formatSizeReport', () => {
  it('ranks cells by payload (biggest first), shows a bar, flags over-ceiling', () => {
    const entries = [
      { name: 'small', size: { files: 1, chars: 400, tokens: 100 } },
      { name: 'big', size: { files: 5, chars: 96000, tokens: 24000 } },
    ];
    const out = formatSizeReport(entries, 16000);
    expect(out).toMatch(/big[\s\S]*small/); // ranked biggest first
    expect(out).toContain('16000'); // ceiling echoed
    expect(out).toContain('⚠'); // over-ceiling flagged
  });

  it('reports all-clear when nothing exceeds the ceiling', () => {
    const entries = [{ name: 'a', size: { files: 1, chars: 400, tokens: 100 } }];
    const out = formatSizeReport(entries, 16000);
    expect(out).toContain('within ceiling');
    expect(out).not.toContain('⚠');
  });
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
  const e = (fromCell: string, toCell: string): Crossing => ({
    fromCell, toCell, fromFile: 'f', toFile: 't', import: 'i',
  });

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
