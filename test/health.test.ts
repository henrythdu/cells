import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupUnresolved } from '../src/gate.js';

const cellsBin = join(__dirname, '..', 'dist', 'cli.js');

describe('cells health', () => {
  describe('on a healthy repo', () => {
    it('exits 0 and shows all checks passed', () => {
      const out = execSync(`node ${cellsBin} health`, { encoding: 'utf8' });
      expect(out).toContain('✓ validate');
      expect(out).toContain('✓ crossings');
      expect(out).toContain('✓ structure');
      // size may be ⚠ (warning, not gate) — the repo's own size drifts as commands grow
      expect(out).toMatch(/(✓|⚠) size/);
      expect(out).toMatch(/All checks passed|Gate passed/);
    });
  });

  describe('on a repo with an undeclared crossing', () => {
    let repo: string;

    afterEach(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    function setupBrokenRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'cells-health-'));
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, '.cells'), { recursive: true });

      writeFileSync(join(dir, 'src', 'a.ts'), `export const x = 1;\n`);
      writeFileSync(join(dir, 'src', 'b.ts'), `import { x } from './a.js';\n`);

      writeFileSync(join(dir, '.cells', 'config.toml'), `code-dirs = ["src"]\n`);
      writeFileSync(join(dir, '.cells', 'a.cell.toml'), `name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n`);
      // b imports a but doesn't require it — undeclared crossing
      writeFileSync(join(dir, '.cells', 'b.cell.toml'), `name = "b"\npurpose = "p"\nprovides = []\nrequires = []\nlayer = 0\n`);
      writeFileSync(join(dir, '.cells', 'ownership.toml'), `[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n`);

      return dir;
    }

    it('exits 1 and flags the failing check', () => {
      repo = setupBrokenRepo();
      try {
        execSync(`node ${cellsBin} health`, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
        // should have thrown
        expect.unreachable('expected exit 1');
      } catch (err: any) {
        expect(err.status).toBe(1);
        expect(err.stdout).toContain('✗ crossings');
        expect(err.stdout).not.toContain('All checks passed');
      }
    });
  });

  describe('on a repo with a size warning (gate stays green)', () => {
    let repo: string;

    afterEach(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    it('exits 0, marks size ⚠, and says gate passed with warning', () => {
      repo = mkdtempSync(join(tmpdir(), 'cells-health-warn-'));
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, '.cells'), { recursive: true });

      // one big file in one cell — no crossings, valid partition, but over the ceiling
      writeFileSync(join(repo, 'src', 'big.ts'), `export const pad = '${'x'.repeat(600)}';\n`);
      writeFileSync(join(repo, '.cells', 'config.toml'), `code-dirs = ["src"]\nmax-payload-tokens = 100\n`);
      writeFileSync(join(repo, '.cells', 'a.cell.toml'), `name = "a"\npurpose = "p"\nprovides = []\nrequires = []\nlayer = 0\n`);
      writeFileSync(join(repo, '.cells', 'ownership.toml'), `[a]\nfiles = ["src/big.ts"]\n`);

      const out = execSync(`node ${cellsBin} health`, { cwd: repo, encoding: 'utf8' });
      expect(out).toContain('⚠ size');
      expect(out).toContain('Gate passed with 1 warning(s)');
      expect(out).not.toContain('All checks passed');
      expect(out).not.toContain('Gate failed');
    });
  });

  describe('on a repo with only a stale require', () => {
    let repo: string;

    afterEach(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    it('cells crossings exits 0 and prints stale as info (not gate failure)', () => {
      repo = mkdtempSync(join(tmpdir(), 'cells-crossings-stale-'));
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, '.cells'), { recursive: true });

      writeFileSync(join(repo, 'src', 'a.ts'), `export const x = 1;\n`);
      writeFileSync(join(repo, '.cells', 'config.toml'), `code-dirs = ["src"]\n`);
      // a requires b but nothing imports b — stale only, must NOT fail the gate
      writeFileSync(join(repo, '.cells', 'a.cell.toml'), `name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = ["b"]\n`);
      writeFileSync(join(repo, '.cells', 'b.cell.toml'), `name = "b"\npurpose = "p"\nprovides = []\nrequires = []\n`);
      writeFileSync(join(repo, '.cells', 'ownership.toml'), `[a]\nfiles = ["src/a.ts"]\n`);

      const res = spawnSync(`node`, [cellsBin, 'crossings'], { cwd: repo, encoding: 'utf8' });
      expect(res.status).toBe(0); // stale is info — must not fail the gate
      expect(res.stderr).toContain('(info) 1 stale require');
      expect(res.stderr).not.toContain('Undeclared');
    });
  });
});

describe('health --summary grouping', () => {
  it('collapses per-entry unresolved into per-file groups, sorted desc, with a representative specifier', () => {
    const lines = groupUnresolved([
      { fromFile: 'a/opencl.cpp', import: 'ggml-kernels.cl.h' },
      { fromFile: 'a/opencl.cpp', import: 'ggml-shaders.cl.h' },
      { fromFile: 'a/opencl.cpp', import: 'ggml-wgsl.cl.h' },
      { fromFile: 'b/kai.cpp', import: 'kai_matmul_x.h' },
      { fromFile: 'b/kai.cpp', import: 'kai_matmul_y.h' },
      { fromFile: 'c/solo.cpp', import: 'stdint.h' },
    ]);
    expect(lines).toEqual(['a/opencl.cpp: 3 unresolved (e.g. "ggml-kernels.cl.h")', 'b/kai.cpp: 2 unresolved (e.g. "kai_matmul_x.h")', 'c/solo.cpp: 1 unresolved (e.g. "stdint.h")']);
  });
});
