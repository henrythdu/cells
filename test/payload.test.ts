import { describe, it, expect } from 'vitest';
import { assemblePayload } from '../src/payload.js';
import type { Cell } from '../src/declaration.js';

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
