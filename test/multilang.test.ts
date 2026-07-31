import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectImportEdges } from '../src/importers.js';
import type { Importer } from '../src/imports.js';

// Regression for the headroom P0: two tree-sitter grammars loaded concurrently (Promise.all
// dispatch) raced web-tree-sitter's shared WASM state — one importer silently returned empty
// and `cells crossings` printed "No cross-cell imports" while `health` stayed green. The
// dispatch is now sequential + failure-surfacing; this asserts both languages actually
// produce edges and that a throwing importer is reported, never swallowed.
const startCwd = process.cwd();
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cells-multilang-'));
  mkdirSync(join(repo, '.cells'));
  writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["."]\ncode-exts = [".py", ".rs", ".zzz"]\n');
  process.chdir(repo);
});
afterEach(() => {
  process.chdir(startCwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('collectImportEdges (multi-language)', () => {
  it('extracts edges for every present language (python + rust together)', async () => {
    writeFileSync(join(repo, 'a.py'), 'import b\n');
    writeFileSync(join(repo, 'b.py'), 'x = 1\n');
    writeFileSync(join(repo, 'c.rs'), 'use crate::d::val;\n');
    writeFileSync(join(repo, 'd.rs'), 'pub const val: i32 = 1;\n');

    const { edges, failures } = await collectImportEdges();
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toContain('a.py -> b.py'); // python importer live
    expect(set).toContain('c.rs -> d.rs'); // rust importer live
    expect(failures).toEqual([]);
  });
});

describe('collectImportEdges (failure surfacing)', () => {
  it('reports a throwing importer in failures instead of swallowing it', async () => {
    writeFileSync(join(repo, 'a.py'), 'import b\n');
    writeFileSync(join(repo, 'b.py'), 'x = 1\n');
    const broken: Importer = {
      name: 'broken',
      extensions: ['.zzz'],
      async extract() {
        throw new Error('boom');
      },
    };
    // .zzz isn't in the census, so selectImporters would skip it — force selection by
    // making it the only importer and a matching file.
    writeFileSync(join(repo, 'x.zzz'), 'whatever');
    const { edges, failures } = await collectImportEdges('.', [broken]);
    expect(edges).toEqual([]);
    expect(failures).toEqual([{ importer: 'broken', error: 'boom' }]);
  });

  it('keeps other importers results when one fails', async () => {
    writeFileSync(join(repo, 'a.py'), 'import b\n');
    writeFileSync(join(repo, 'b.py'), 'x = 1\n');
    writeFileSync(join(repo, 'x.rs'), 'fn main() {}\n');
    const broken: Importer = {
      name: 'broken',
      extensions: ['.rs'],
      async extract() {
        throw new Error('boom');
      },
    };
    const { edges, failures } = await collectImportEdges('.', [broken]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ importer: 'broken', error: 'boom' });
    expect(edges).toEqual([]); // the broken importer owned .rs — its edges are missing, reported
  });
});
