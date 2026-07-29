import { describe, it, expect } from 'vitest';
import { formatCellList, formatCellShow, formatSizeReport } from '../src/view.js';
import type { CellSize } from '../src/payload.js';
import type { Cell } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';
import type { CellMetrics, Crossing } from '../src/crossings.js';

const decls: Record<string, Cell> = {
  declaration: {
    name: 'declaration',
    purpose: 'parse',
    provides: ['parseCell'],
    requires: [],
  },
  cli: {
    name: 'cli',
    purpose: 'wire',
    provides: ['main'],
    requires: ['declaration'],
  },
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
    {
      fromCell: 'validate',
      toCell: 'ownership',
      fromFile: 'src/validate.ts',
      toFile: 'src/ownership.ts',
      import: './ownership',
    },
    {
      fromCell: 'validate',
      toCell: 'declaration',
      fromFile: 'src/validate.ts',
      toFile: 'src/declaration.ts',
      import: './declaration',
    },
  ];
  const inc: Crossing[] = [
    {
      fromCell: 'cli',
      toCell: 'validate',
      fromFile: 'src/cli.ts',
      toFile: 'src/validate.ts',
      import: './validate',
    },
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

  it('shows the layer when set; omits the line when layerless', () => {
    const layered = formatCellShow({ ...cell, layer: 1 }, owned, out, inc, size, metrics);
    expect(layered).toContain('layer: 1');
    expect(out2).not.toMatch(/^layer:/m); // the `cell` fixture (validate) has no layer
  });

  it('shows signatures when present, one per line below provides', () => {
    const signed: Cell = {
      ...cell,
      signatures: ['parseCell(raw: string): Cell', 'serializeCell(cell: Cell): string'],
    };
    const out3 = formatCellShow(signed, owned, out, inc, size, metrics);
    expect(out3).toContain('\u2022 parseCell(raw: string): Cell');
    expect(out3).toContain('\u2022 serializeCell(cell: Cell): string');
    // signatures line appears after provides, before requires
    expect(out3).toMatch(/validatePartition[\s\S]*\u2022 parseCell[\s\S]*requires:/);
  });

  it('shows test files when the cell declares them', () => {
    const withTests: Cell = { ...cell, tests: ['test/validate.test.ts'] };
    const out4 = formatCellShow(withTests, owned, out, inc, size, metrics);
    expect(out4).toContain('tests (1 file):');
    expect(out4).toContain('test/validate.test.ts');
  });

  it('aggregates imported-by edges by cell when count exceeds the threshold', () => {
    // 10 inbound edges: 6 from placement, 4 from infra — collapses to placement×6, infra×4
    const manyIn: Crossing[] = [];
    for (let i = 0; i < 6; i++) manyIn.push({ fromCell: 'placement', toCell: 'validate', fromFile: `src/p${i}.ts`, toFile: 'src/validate.ts', import: './v' });
    for (let i = 0; i < 4; i++) manyIn.push({ fromCell: 'infra', toCell: 'validate', fromFile: `src/i${i}.ts`, toFile: 'src/validate.ts', import: './v' });
    const out5 = formatCellShow(cell, owned, out, manyIn, size, { ...metrics, fanIn: 10 });
    expect(out5).toContain('imported by (10):');
    expect(out5).toContain('placement×6, infra×4');
    expect(out5).toContain('--verbose for per-file detail');
    expect(out5).not.toContain('src/p0.ts'); // raw detail hidden
  });

  it('--verbose shows raw per-file edges even past the threshold', () => {
    const manyIn: Crossing[] = [];
    for (let i = 0; i < 9; i++) manyIn.push({ fromCell: 'placement', toCell: 'validate', fromFile: `src/p${i}.ts`, toFile: 'src/validate.ts', import: './v' });
    const out5 = formatCellShow(cell, owned, out, manyIn, size, { ...metrics, fanIn: 9 }, true);
    expect(out5).toContain('← placement   (src/p0.ts → src/validate.ts)');
    expect(out5).not.toContain('placement×9');
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
