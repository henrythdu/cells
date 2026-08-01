import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadContext, listCodeFiles } from '../src/io.js';
import { loadCrossings, warnIfNoCodeFiles, cmdShow } from '../src/commands/read.js';
import type { CellsConfig } from '../src/config.js';

let repo: string;
const startCwd = process.cwd();

function git(args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
}

/** A python fixture: cells a + b (no imports anywhere) + a committed HEAD, so cmdShow can
 *  render dead-at-boundary (nobody imports c.py) and co-change (c.py + b.py share commit 1). */
function setupShowRepo(): void {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.cells'), { recursive: true });
  writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".py"]\nmodule-root = "src"\n');
  writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'c.cell.toml'), 'name = "c"\npurpose = "p"\nprovides = ["z"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'ownership.toml'), '[b]\nfiles = ["src/b.py"]\n[c]\nfiles = ["src/c.py"]\n');
  writeFileSync(join(repo, 'src', 'b.py'), 'y = 2\n');
  writeFileSync(join(repo, 'src', 'c.py'), 'z = 3\n');
  git('init');
  git('config user.email t@t');
  git('config user.name t');
  git('add -A');
  git('commit -m one'); // b + c co-change (both new)
}

describe('commands/read — the assembly the CLI tests only reach indirectly', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-cmds-'));
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

  it('cmdShow renders dead-at-boundary + co-change sections from the ctx it assembles', async () => {
    setupShowRepo();
    const ctx = loadContext();
    const out: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = (s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    };
    try {
      await cmdShow(ctx, 'c');
    } finally {
      process.stdout.write = orig;
    }
    const rendered = out.join('');
    expect(rendered).toContain('no other cell imports (static view — check for entry points before deleting):');
    expect(rendered).toContain('  src/c.py'); // dead — nothing imports it
    expect(rendered).toContain('co-changes in git history');
    expect(rendered).toContain('src/b.py  (cell b · 1×)'); // c.py + b.py co-changed in commit 1
    expect(listCodeFiles().length).toBeGreaterThan(0); // census sanity
  });
});
