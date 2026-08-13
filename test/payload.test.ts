import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/declaration.js';
import { assemblePayload } from '../src/payload.js';

describe('assemblePayload', () => {
  it('assembles declaration + owned code + neighbor membranes into one doc', () => {
    const cell: Cell = {
      name: 'parser',
      purpose: 'Turn a .cell file into a checked Cell AST.',
      provides: ['parseCell'],
      requires: ['ownership'],
    };
    const ownedFiles = ['src/parser.ts'];
    const fileContents = { 'src/parser.ts': 'export function parseCell() {}' };
    const neighbors: Cell[] = [
      {
        name: 'ownership',
        purpose: 'The path to cell ownership map.',
        provides: ['getOwnedFiles'],
        requires: [],
      },
    ];

    // Expected doc — hand-written literal (independent of the formatter).
    const expected = [
      '# Cell: parser',
      '',
      '## Declaration',
      'purpose: Turn a .cell file into a checked Cell AST.',
      'provides: [parseCell]',
      'requires: [ownership]',
      '',
      '## Your code',
      '### src/parser.ts',
      'export function parseCell() {}',
      '',
      '## Neighbor contracts',
      '### Cell: ownership',
      'purpose: The path to cell ownership map.',
      'provides: [getOwnedFiles]',
      'requires: []',
      '',
    ].join('\n');

    expect(assemblePayload(cell, ownedFiles, fileContents, neighbors)).toBe(expected);
  });

  it('includes neighbor signatures in the neighbor contracts section', () => {
    const cell: Cell = { name: 'cli', purpose: 'wire', provides: [], requires: ['parser'] };
    const neighbors: Cell[] = [
      {
        name: 'parser',
        purpose: 'parse declarations',
        provides: ['parseCell', 'serializeCell'],
        requires: [],
        signatures: ['parseCell(raw: string): Cell', 'serializeCell(cell: Cell): string'],
      },
    ];

    const result = assemblePayload(cell, [], {}, neighbors);
    expect(result).toContain('signatures:');
    expect(result).toContain('  - parseCell(raw: string): Cell');
    expect(result).toContain('  - serializeCell(cell: Cell): string');
  });

  it('includes context section with direct dependents count when provided', () => {
    const cell: Cell = { name: 'core', purpose: 'p', provides: [], requires: [] };

    // with dependents
    const result = assemblePayload(cell, [], {}, [], 3);
    expect(result).toContain('## Context');
    expect(result).toContain('impact: 3 cell(s) directly depend on this cell');
    expect(result).toContain('`cells impact core`');

    // zero dependents
    const leaf = assemblePayload(cell, [], {}, [], 0);
    expect(leaf).toContain('impact: no cells depend on this cell (leaf)');

    // not provided — no context section
    const noCtx = assemblePayload(cell, [], {}, []);
    expect(noCtx).not.toContain('## Context');
  });

  it('lists the cells that depend on this one (reverse contract) with their requires', () => {
    const cell: Cell = { name: 'io', purpose: 'p', provides: ['readFiles'], requires: [] };
    const dependents: Cell[] = [
      { name: 'commands', purpose: 'handlers', provides: [], requires: ['io', 'crossings'] },
      { name: 'cli', purpose: 'dispatch', provides: [], requires: ['io', 'commands'] },
    ];
    const result = assemblePayload(cell, [], {}, [], 2, undefined, undefined, dependents);
    expect(result).toContain('## Cells that depend on you');
    expect(result).toContain('### Cell: commands');
    expect(result).toContain('requires: [io, crossings]'); // what commands expects from io (and others)
    expect(result).toContain('### Cell: cli');
    // no dependents → no section
    const none = assemblePayload(cell, [], {}, [], 0);
    expect(none).not.toContain('## Cells that depend on you');
  });

  it('includes test code section when test files are provided', () => {
    const cell: Cell = { name: 'parser', purpose: 'p', provides: [], requires: [] };
    const testFiles = ['test/parser.test.ts'];
    const testContents = { 'test/parser.test.ts': "import { describe, it } from 'vitest';" };

    const result = assemblePayload(cell, [], {}, [], undefined, testFiles, testContents);
    expect(result).toContain('## Tests');
    expect(result).toContain('### test/parser.test.ts');
    expect(result).toContain("import { describe, it } from 'vitest';");
  });
});

describe('change coupling hint', () => {
  const cell = { name: 'a', purpose: 'p', provides: [], requires: [], layer: 0 };

  it('appends the Change coupling block only when coupled partners are passed (zero tokens when clean)', () => {
    const clean = assemblePayload(cell, [], {}, []);
    expect(clean).not.toContain('Change coupling');
    const withHint = assemblePayload(cell, [], {}, [], undefined, undefined, undefined, undefined, [
      { cell: 'b', count: 42, window: 200, files: ['src/b.py', 'src/c.py'] },
      { cell: 'c', count: 17, window: 200 },
    ]);
    expect(withHint).toContain('## Change coupling');
    expect(withHint).toContain("⚠ b co-changes with you (42/200 commits, no import edge) — pull b's payload before touching its code, its context is invisible to you; co-changing files: src/b.py, src/c.py");
    expect(withHint).toContain("⚠ c co-changes with you (17/200 commits, no import edge) — pull c's payload before touching its code, its context is invisible to you"); // no files → no suffix
  });
});
