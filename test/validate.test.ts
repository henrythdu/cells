import { describe, it, expect } from 'vitest';
import { validatePartition } from '../src/validate.js';
import type { Cell } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';

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
