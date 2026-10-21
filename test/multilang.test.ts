import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectImportEdges, DEFAULT_IMPORTERS } from '../src/importers.js';
import type { Importer } from '../src/imports.js';

// A regression guard. Two tree-sitter grammars loaded at the same time, with a `Promise.all`
// dispatch, raced the shared WASM state of web-tree-sitter. One importer silently returned
// empty results, and `cells crossings` printed "No cross-cell imports" while `health` stayed
// green. The dispatch is now sequential and surfaces a failure. This test asserts that both
// languages produce edges, and that a throwing importer is reported and never swallowed.
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
    expect(set).toContain('a.py -> b.py'); // The python importer is live.
    expect(set).toContain('c.rs -> d.rs'); // The rust importer is live.
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
    // The extension `.zzz` is not in the census, so `selectImporters` would skip it. The test
    // forces the selection by making this importer the only one, with a matching file.
    writeFileSync(join(repo, 'x.zzz'), 'whatever');
    const { edges, failures } = await collectImportEdges('.', [broken]);
    expect(edges).toEqual([]);
    expect(failures).toEqual([{ importer: 'broken', error: 'boom' }]);
  });

  it('keeps other importers results when one fails (per-importer failure, sequential dispatch)', async () => {
    writeFileSync(join(repo, 'a.py'), 'import b\n');
    writeFileSync(join(repo, 'b.py'), 'x = 1\n');
    writeFileSync(join(repo, 'x.zzz'), 'whatever\n');
    const broken: Importer = {
      name: 'broken',
      extensions: ['.zzz'],
      async extract() {
        throw new Error('boom');
      },
    };
    // The broken importer rides ALONGSIDE the defaults: the healthy importers must still
    // produce their edges while the failure is reported, and never swallowed.
    const { edges, failures } = await collectImportEdges('.', [...DEFAULT_IMPORTERS, broken]);
    expect(failures).toEqual([{ importer: 'broken', error: 'boom' }]);
    expect(edges.some((e) => e.fromFile === 'a.py' && e.toFile === 'b.py')).toBe(true); // The edge of python survived.
  });
});
