import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/declaration.js';
import type { Ownership } from '../src/ownership.js';
import { isUnsafePath, providesDrift, staleProvidesOf, validatePartition } from '../src/validate.js';

/** Build the declarations map from a map of name to requires. */
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
    expect(validatePartition(ownership, declarations, codeFiles, () => true)).toEqual([]);
  });

  it('flags a data-requires entry naming an unknown cell (integrity parity with requires)', () => {
    const ownership: Ownership = { parser: ['src/parser.ts'] };
    const declarations = decls({ parser: [] });
    declarations.parser.dataRequires = ['ghost'];
    const v = validatePartition(ownership, declarations, ['src/parser.ts'], () => true);
    expect(v.some((x) => x.kind === 'unknown-require' && x.detail.includes('data-requires') && x.detail.includes('ghost'))).toBe(true);
  });

  it('flags a file owned by two cells (single-valued)', () => {
    const ownership: Ownership = { parser: ['src/shared.ts'], util: ['src/shared.ts'] };
    const declarations = decls({ parser: [], util: [] });
    const codeFiles = ['src/shared.ts'];
    const v = validatePartition(ownership, declarations, codeFiles, () => true);
    expect(v.some((x) => x.kind === 'duplicate' && x.detail.includes('src/shared.ts'))).toBe(true);
  });

  it('does NOT flag unowned files (orphans are visibility, not violations)', () => {
    const ownership: Ownership = { parser: ['src/parser.ts'] };
    const declarations = decls({ parser: [] });
    const codeFiles = ['src/parser.ts', 'src/orphan.ts'];
    expect(validatePartition(ownership, declarations, codeFiles, () => true)).toEqual([]);
  });

  it('flags owned paths that are absolute or escape the repo root (unsafe-path)', () => {
    const ownership: Ownership = { parser: ['../outside.ts', '/etc/passwd'] };
    const declarations = decls({ parser: [] });
    const v = validatePartition(ownership, declarations, ['src/parser.ts'], () => true);
    expect(v.filter((x) => x.kind === 'unsafe-path')).toHaveLength(2);
    // The unsafe entries are excluded from the other checks, so they are not also 'dangling' or 'outside-census'.
    expect(v.filter((x) => x.kind === 'dangling' || x.kind === 'outside-census')).toHaveLength(0);
  });

  it('splits vanished files (dangling) from census-excluded files (outside-census)', () => {
    const ownership: Ownership = { parser: ['src/gone.ts', 'build/gen.ts'] };
    const declarations = decls({ parser: [] });
    // build/gen.ts exists on disk, but the census never saw it because build/ is skip-listed.
    // src/gone.ts is gone. The census input is the same, and the disk truth is different, so
    // the kinds are different.
    const v = validatePartition(ownership, declarations, ['src/parser.ts'], (f) => f === 'build/gen.ts');
    expect(v.some((x) => x.kind === 'outside-census' && x.detail.includes('build/gen.ts') && x.detail.includes('skip-listed'))).toBe(true);
    expect(v.some((x) => x.kind === 'dangling' && x.detail.includes('src/gone.ts'))).toBe(true);
  });
});

describe('isUnsafePath', () => {
  it('flags absolute and ..-escaping paths, accepts repo-relative ones', () => {
    expect(isUnsafePath('../x.ts')).toBe(true);
    expect(isUnsafePath('../../x.ts')).toBe(true);
    expect(isUnsafePath('/etc/passwd')).toBe(true);
    expect(isUnsafePath('C:\\win.ts')).toBe(true);
    expect(isUnsafePath('src/a.ts')).toBe(false);
    expect(isUnsafePath('src/a/../b.ts')).toBe(false); // The path normalizes to a location inside the repository.
  });
});

describe('staleProvidesOf', () => {
  const cell = (provides: string[]): Cell => ({ name: 'cell', purpose: '...', provides, requires: [] });

  it('flags a provides entry whose token no owned file references (membrane drift)', () => {
    const c = cell(['parseCell', 'Cell']);
    const contents = { 'src/cell.ts': 'export interface Cell {}' }; // parseCell is gone, and Cell is present.
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

  it('flags deleted snake_case with no mention anywhere (clean deletion — the widening case)', () => {
    const c = cell(['cap_output_width']);
    expect(staleProvidesOf(c, ['views.py'], { 'views.py': 'def begin_answer(): pass\n' })).toEqual([{ cell: 'cell', provide: 'cap_output_width' }]);
  });

  it('flags deleted private snake_case (leading underscore — the _drawn_portions shape)', () => {
    const c = cell(['_private_name']);
    expect(staleProvidesOf(c, ['views.py'], { 'views.py': 'x = 1\n' })).toEqual([{ cell: 'cell', provide: '_private_name' }]);
  });

  it('stays silent when the token survives only in a sibling docstring (characterization — presence of a mention is not proof of life, but it suppresses)', () => {
    // The house style of PID_Demo cites removed code as history. The reference check works
    // on text, so a mention in a docstring suppresses the report. This silence is intended:
    // the definition-shaped form belongs in the consumer suites, not in an advisory line.
    const c = cell(['fn_name()']);
    const contents = { 'a.py': 'def other(): pass\n', 'b.py': '"""the cap had a second home at fn_name"""\n' };
    expect(staleProvidesOf(c, ['a.py', 'b.py'], contents)).toEqual([]);
  });

  it('still fires for fn-call snake_case with no mention (regression pin on shared providesToken)', () => {
    const c = cell(['cap_output_width()']);
    expect(staleProvidesOf(c, ['views.py'], { 'views.py': 'pass\n' })).toEqual([{ cell: 'cell', provide: 'cap_output_width()' }]);
  });

  it('suppresses when the snake_case token lives in a sibling owned file (render_component shape)', () => {
    const c = cell(['render_component']);
    const contents = { 'views.py': 'pass\n', 'renderer.py': 'def render_component(c): ...\n' };
    expect(staleProvidesOf(c, ['views.py', 'renderer.py'], contents)).toEqual([]);
  });

  it('fires on underscored prose as a documented edge (near-zero prose-FP class, not empty)', () => {
    // The rule treats "ad_hoc" as identifier-shaped. An underscored prose entry that matches
    // is close to a signal. The test pins the documented behavior: the class is almost empty,
    // but not empty.
    const c = cell(['ad_hoc']);
    expect(staleProvidesOf(c, ['doc.py'], { 'doc.py': 'pass\n' })).toEqual([{ cell: 'cell', provide: 'ad_hoc' }]);
  });

  it('counts dot-preceded (attribute-tail) references — a name only ever used as pkg.attr must not fire', () => {
    // The evidence from PID_Demo: `on_chat_start` survives in app.py only as
    // `cl.on_chat_start`, the decorator. Attribute tails ARE reference sources: the pilots
    // attach them as edge symbols, and the boundary rule accepts a `.` before the token in
    // text. Therefore this test stays silent.
    //
    // A mirror check that excluded matches after a dot fired here. The test pins the
    // behavior, so the boundary cannot "fix" itself into that hole.
    //
    // `cl.on_chat_start` is the reference, and the decorated function is `start`. The
    // reference and the definition are different, and the reference is correct.
    const c = cell(['on_chat_start']);
    const contents = { 'app.py': 'import chainlit as cl\n@cl.on_chat_start\nasync def start(): pass\n' };
    expect(staleProvidesOf(c, ['app.py'], contents)).toEqual([]);
  });

  it('skips single-word lowercase and dunders (ambiguous with prose)', () => {
    const c = cell(['port', 'stash', '__all__']);
    expect(staleProvidesOf(c, ['views.py'], { 'views.py': 'pass\n' })).toEqual([]);
  });
});

describe('providesDrift (unread subsumes stale — one name, one verdict)', () => {
  const cell = (name: string, provides: string[]): Cell => ({ name, purpose: '...', provides, requires: [] });
  // None of the tokens appears in the owned text of home, so all four are stale candidates.
  // A reader elsewhere decides stale against unread. A definition would suppress stale at once.
  const decls = { home: cell('home', ['LITERAL_BOUND', 'EDGE_READ', 'DRAWINGS_DIR', 'TOP_ONLY']), other: cell('other', []) };
  const ownership: Ownership = { home: ['home/a.ts'], other: ['other/b.ts'] };
  const contents = {
    'home/a.ts': 'export const OTHER = 1;\n',
    // A string binding in the TOOL_MAP style and a dotted top-only read. Neither has an import edge.
    'other/b.ts': 'const TOOL_MAP = { LITERAL_BOUND: 1 }; import pkg.sub; pkg.TOP_ONLY;\n',
  };
  const edges = [{ fromFile: 'other/b.ts', toFile: 'home/a.ts', import: 'home/a', symbols: ['EDGE_READ'] }];
  const staleNames = (d: { stale: { provide: string }[] }) => d.stale.map((s) => s.provide);
  const unreadNames = (d: { unread: { provide: string }[] }) => d.unread.map((u) => u.provide);

  it('keeps import-edge readers on the stale line, off the unread line', () => {
    const d = providesDrift(decls, ownership, edges, contents);
    expect(staleNames(d)).toContain('EDGE_READ'); // The name is shared and stale, which is a legitimate re-export shape.
    expect(unreadNames(d)).not.toContain('EDGE_READ');
  });

  it('keeps string-literal readers (TOOL_MAP binding) off the unread line', () => {
    const d = providesDrift(decls, ownership, edges, contents);
    expect(staleNames(d)).toContain('LITERAL_BOUND');
    expect(unreadNames(d)).not.toContain('LITERAL_BOUND');
  });

  it('flags truly unread provides (DRAWINGS_DIR shape) as unread, not stale', () => {
    const d = providesDrift(decls, ownership, edges, contents);
    expect(unreadNames(d)).toContain('DRAWINGS_DIR');
    expect(staleNames(d)).not.toContain('DRAWINGS_DIR'); // The unread result contains the name, so there is one verdict.
  });

  it('covers dotted-top-only reads via the literal scan (the feared blind spot never fires)', () => {
    // `import pkg.sub; pkg.TOP_ONLY` is invisible as an EDGE, because the binding is top-only
    // and there is no pkg edge. But the read is present as text, and the literal scan reads
    // text and not edges. The premise of D3 does not hold: the silence here is correct and
    // not a miss.
    const d = providesDrift(decls, ownership, edges, contents);
    expect(unreadNames(d)).not.toContain('TOP_ONLY');
  });

  it('never flags names used in owned files (in-cell readers suppress)', () => {
    const d = providesDrift({ home: cell('home', ['IN_CELL']), other: decls.other }, ownership, [], { ...contents, 'home/a.ts': 'export function IN_CELL() {} IN_CELL();\n' });
    expect(d.stale).toEqual([]);
    expect(d.unread).toEqual([]);
  });

  it('extends the suppression chain to snake_case: cross-cell string-literal reader keeps it stale, not unread', () => {
    // The wider token class goes through the evidence sources of the unread check unchanged.
    const d = providesDrift({ home: cell('home', ['tool_registry']), other: cell('other', []) }, ownership, [], { 'home/a.ts': 'pass\n', 'other/b.ts': 'const TOOL_MAP = { tool_registry: 1 };\n' });
    expect(staleNames(d)).toContain('tool_registry');
    expect(unreadNames(d)).not.toContain('tool_registry');
  });
});
