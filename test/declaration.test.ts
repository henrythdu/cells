import { describe, it, expect } from 'vitest';
import { parseCell, serializeCell, type Cell } from '../src/declaration.js';

describe('parseCell', () => {
  it('parses a well-formed cell declaration', () => {
    // Fixture — independent source of truth (hand-written, not derived).
    const toml = [
      'name = "parser"',
      'purpose = "Turn a .cell declaration file into a checked Cell AST."',
      'provides = ["parseCell", "validateOwnership"]',
      'requires = ["ownership"]',
      '',
    ].join('\n');

    // Expected values are hand-written literals, not recomputed by the parser.
    expect(parseCell(toml)).toEqual({
      name: 'parser',
      purpose: 'Turn a .cell declaration file into a checked Cell AST.',
      provides: ['parseCell', 'validateOwnership'],
      requires: ['ownership'],
    });
  });

  it('parses an optional layer tag', () => {
    const toml = [
      'name = "domain"',
      'purpose = "core policy"',
      'provides = ["decide"]',
      'requires = []',
      'layer = "domain"',
      '',
    ].join('\n');
    expect(parseCell(toml)).toEqual({
      name: 'domain',
      purpose: 'core policy',
      provides: ['decide'],
      requires: [],
      layer: 'domain',
    });
  });
});

describe('serializeCell', () => {
  it('round-trips through parseCell', () => {
    const cell: Cell = {
      name: 'parser',
      purpose: 'Turn a .cell declaration file into a checked Cell AST.',
      provides: ['parseCell', 'Cell'],
      requires: ['util', 'token'],
    };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });

  it('escapes embedded quotes in purpose', () => {
    const cell: Cell = { name: 'c', purpose: 'say "hi"', provides: [], requires: [] };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });

  it('round-trips a layer tag', () => {
    const cell: Cell = { name: 'domain', purpose: 'p', provides: ['decide'], requires: [], layer: 'domain' };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });
});
