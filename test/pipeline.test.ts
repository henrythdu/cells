import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CellsConfig } from '../src/config.js';
import { loadContext } from '../src/io.js';
import { loadCrossings, warnIfNoCodeFiles } from '../src/pipeline.js';

let repo: string;
const startCwd = process.cwd();

describe('pipeline — the gather-and-guard seam every analysis command routes through', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-pipeline-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('warnIfNoCodeFiles points at config.toml when the census is empty', () => {
    const errs: string[] = [];
    const spy = (m: string) => errs.push(m);
    const orig = console.error;
    console.error = spy;
    try {
      const cfg: CellsConfig = { maxPayloadTokens: 16000, layers: {}, codeDirs: ['src', 'test'], codeExts: ['.ts'], ignoreBlindExts: [] };
      warnIfNoCodeFiles(cfg, []);
    } finally {
      console.error = orig;
    }
    expect(errs.join('\n')).toContain('0 code files match code-exts=[.ts]');
  });

  it('loadCrossings filters unresolved imports from UNOWNED files (owned only matter to the partition)', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.cells'), { recursive: true });
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".py"]\nmodule-root = "src"\n');
    writeFileSync(join(repo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.py", "src/owned.py"]\n');
    writeFileSync(join(repo, 'src', 'a.py'), 'x = 1\n');
    writeFileSync(join(repo, 'src', 'owned.py'), 'import a.zzz\n'); // local-looking, submodule missing → unresolved
    writeFileSync(join(repo, 'src', 'loose.py'), 'import a.zzz\n'); // same, but UNOWNED → filtered

    const ctx = loadContext();
    const { unresolved } = await loadCrossings(ctx.ownership);
    expect(unresolved.map((u) => u.fromFile)).toEqual(['src/owned.py']); // loose.py dropped
  });
});
