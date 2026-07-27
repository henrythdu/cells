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
});
