import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';
import { staleProvidesOf, validatePartition } from '../src/validate.js';

/** Helper: build a declarations map from { name: [requires] }. */
function decls(cells: Record<string, string[]>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [name, requires] of Object.entries(cells)) {
    out[name] = { name, purpose: '...', provides: [], requires };
  }
  return out;
}

describe('validatePartition', () => {
  it('returns no violations for a valid partition', () => {
    const ownership: Ownership = { parser: ['src/parser.ts'], util: ['src/util.ts'] };
    const declarations = decls({ parser: ['util'], util: [] });
    const codeFiles = ['src/parser.ts', 'src/util.ts'];
    expect(validatePartition(ownership, declarations, codeFiles)).toEqual([]);
  });

  it('flags a file owned by two cells (single-valued)', () => {
    const ownership: Ownership = { parser: ['src/shared.ts'], util: ['src/shared.ts'] };
    const declarations = decls({ parser: [], util: [] });
    const codeFiles = ['src/shared.ts'];
    const v = validatePartition(ownership, declarations, codeFiles);
    expect(v.some((x) => x.kind === 'duplicate' && x.detail.includes('src/shared.ts'))).toBe(true);
  });

  it('does NOT flag unowned files (orphans are visibility, not violations)', () => {
    const ownership: Ownership = { parser: ['src/parser.ts'] };
    const declarations = decls({ parser: [] });
    const codeFiles = ['src/parser.ts', 'src/orphan.ts'];
    expect(validatePartition(ownership, declarations, codeFiles)).toEqual([]);
  });
});

describe('staleProvidesOf', () => {
  const cell = (provides: string[]): Cell => ({ name: 'cell', purpose: '...', provides, requires: [] });

  it('flags a provides entry whose token no owned file references (membrane drift)', () => {
    const c = cell(['parseCell', 'Cell']);
    const contents = { 'src/cell.ts': 'export interface Cell {}' }; // parseCell gone, Cell present
    expect(staleProvidesOf(c, ['src/cell.ts'], contents)).toEqual([{ cell: 'cell', provide: 'parseCell' }]);
  });

  it('matches function-call-style entries and camelCase tokens', () => {
    const c = cell(['collectImportEdges() — the entry point', 'DEFAULT_IMPORTERS registry']);
    const contents = { 'src/cell.ts': 'export function collectImportEdges() {} const DEFAULT_IMPORTERS = [];' };
    expect(staleProvidesOf(c, ['src/cell.ts'], contents)).toEqual([]);
  });

  it('skips pure-prose entries (no identifier token) — never a false positive', () => {
    const c = cell(['the parse loop', 'A deep module']);
    expect(staleProvidesOf(c, ['src/cell.ts'], { 'src/cell.ts': 'unrelated code' })).toEqual([]);
  });

  it('does not match a longer identifier (word boundary)', () => {
    const c = cell(['parseCell']);
    const contents = { 'src/cell.ts': 'export function parseCellExtra() {}' }; // parseCell inside a longer identifier
    expect(staleProvidesOf(c, ['src/cell.ts'], contents)).toEqual([{ cell: 'cell', provide: 'parseCell' }]);
  });
});
