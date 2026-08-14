import { describe, expect, it } from 'vitest';
import { type Cell, editCellName, editCellRequires, parseCell, serializeCell } from '../src/declaration.js';

describe('parseCell', () => {
  it('parses a well-formed cell declaration', () => {
    // Fixture — independent source of truth (hand-written, not derived).
    const toml = ['name = "parser"', 'purpose = "Turn a .cell declaration file into a checked Cell AST."', 'provides = ["parseCell", "validateOwnership"]', 'requires = ["ownership"]', ''].join('\n');

    // Expected values are hand-written literals, not recomputed by the parser.
    expect(parseCell(toml)).toEqual({
      name: 'parser',
      purpose: 'Turn a .cell declaration file into a checked Cell AST.',
      provides: ['parseCell', 'validateOwnership'],
      requires: ['ownership'],
    });
  });

  it('parses an optional layer tag', () => {
    const toml = ['name = "domain"', 'purpose = "core policy"', 'provides = ["decide"]', 'requires = []', 'layer = 2', ''].join('\n');
    expect(parseCell(toml)).toEqual({
      name: 'domain',
      purpose: 'core policy',
      provides: ['decide'],
      requires: [],
      layer: 2,
    });
  });

  it('parses an optional per-cell ceiling (token override)', () => {
    const toml = ['name = "huge"', 'purpose = "big crate"', 'provides = []', 'requires = []', 'ceiling = 50000', ''].join('\n');
    expect(parseCell(toml).ceiling).toBe(50000);
  });

  it('rejects a non-number ceiling', () => {
    const toml = ['name = "huge"', 'purpose = "p"', 'provides = []', 'requires = []', 'ceiling = "lots"', ''].join('\n');
    expect(() => parseCell(toml)).toThrow(/ceiling/);
  });

  it('rejects a non-positive ceiling (would crash the size bar)', () => {
    expect(() => parseCell('name = "c"\npurpose = "p"\nprovides = []\nrequires = []\nceiling = 0\n')).toThrow(/ceiling.*positive/);
    expect(() => parseCell('name = "c"\npurpose = "p"\nprovides = []\nrequires = []\nceiling = -1\n')).toThrow(/ceiling.*positive/);
  });

  it('throws a clear error on a malformed provides (not a string array)', () => {
    const toml = 'name = "c"\npurpose = "p"\nprovides = "not-an-array"\nrequires = []\n';
    expect(() => parseCell(toml)).toThrow(/provides.*string array/);
  });

  it('parses an optional signatures array', () => {
    const toml = ['name = "parser"', 'purpose = "parse"', 'provides = ["parseCell"]', 'requires = []', 'signatures = ["parseCell(raw: string): Cell"]', ''].join('\n');
    expect(parseCell(toml)).toEqual({
      name: 'parser',
      purpose: 'parse',
      provides: ['parseCell'],
      requires: [],
      signatures: ['parseCell(raw: string): Cell'],
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

  it('escapes control characters — a multi-line purpose round-trips', () => {
    const cell: Cell = { name: 'c', purpose: 'line one\nline two', provides: [], requires: [] };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });

  it('round-trips a layer tag', () => {
    const cell: Cell = { name: 'domain', purpose: 'p', provides: ['decide'], requires: [], layer: 2 };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });

  it('round-trips a per-cell ceiling', () => {
    const cell: Cell = { name: 'huge', purpose: 'p', provides: [], requires: [], ceiling: 50000 };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });

  it('round-trips with signatures', () => {
    const cell: Cell = {
      name: 'parser',
      purpose: 'parse declarations',
      provides: ['parseCell', 'serializeCell'],
      requires: ['ownership'],
      signatures: ['parseCell(raw: string): Cell', 'serializeCell(cell: Cell): string'],
    };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });

  it('parses an optional tests array', () => {
    const toml = ['name = "parser"', 'purpose = "p"', 'provides = []', 'requires = []', 'tests = ["test/parser.test.ts"]', ''].join('\n');
    expect(parseCell(toml)).toEqual({
      name: 'parser',
      purpose: 'p',
      provides: [],
      requires: [],
      tests: ['test/parser.test.ts'],
    });
  });

  it('round-trips with tests', () => {
    const cell: Cell = {
      name: 'parser',
      purpose: 'p',
      provides: [],
      requires: [],
      tests: ['test/parser.test.ts', 'test/integration.test.ts'],
    };
    expect(parseCell(serializeCell(cell))).toEqual(cell);
  });
});

describe('comment-preserving rewrites (editCellName / editCellRequires)', () => {
  const authored = ['# the parser membrane', 'name = "parser"', 'purpose = "p" # inline purpose note', 'provides = ["parseCell"]', 'requires = [', '  "toml", # shared codec', '  "ownership",', '] # trailing note', 'layer = 1'].join('\n');

  it('editCellName rewrites only the name value — comments and layout survive', () => {
    const out = editCellName(authored, 'parser2');
    expect(out).toContain('name = "parser2"');
    expect(out).toContain('# the parser membrane');
    expect(out).toContain('  "toml", # shared codec');
    expect(parseCell(out).name).toBe('parser2');
  });

  it('editCellName throws when no name line exists (never a silent no-op)', () => {
    expect(() => editCellName('purpose = "p"\n', 'x')).toThrow(/name/);
  });

  it('editCellRequires renames an entry in place — comments survive', () => {
    const out = editCellRequires(authored, { rename: ['toml', 'toml2'] });
    expect(parseCell(out).requires).toEqual(['toml2', 'ownership']);
    expect(out).toContain('# shared codec');
    expect(out).toContain('] # trailing note');
  });

  it('editCellRequires removes entries — remaining entries and comments survive', () => {
    const out = editCellRequires(authored, { remove: ['toml'] });
    expect(parseCell(out).requires).toEqual(['ownership']);
    expect(out).toContain('# shared codec');
  });

  it('editCellRequires removing every entry collapses to requires = [] (valid TOML)', () => {
    const out = editCellRequires(authored, { remove: ['toml', 'ownership'] });
    expect(parseCell(out).requires).toEqual([]);
    expect(out).toContain('name = "parser"');
  });

  it('editCellRequires scans past a "]" inside a comment (matching-bracket scanner)', () => {
    const tricky = 'name = "a"\npurpose = "p"\nprovides = []\nrequires = [ # note with ] bracket\n  "x",\n]\n';
    const out = editCellRequires(tricky, { remove: ['x'] });
    expect(parseCell(out).requires).toEqual([]);
  });

  it('editCellRequires leaves a file without requires unchanged', () => {
    const noReq = 'name = "a"\npurpose = "p"\nprovides = []\n';
    expect(editCellRequires(noReq, { remove: ['x'] })).toBe(noReq);
  });
});
