import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const cellsBin = join(__dirname, '..', 'dist', 'cli.js');

describe('cells health', () => {
  describe('on a healthy repo', () => {
    it('exits 0 and shows all checks passed', () => {
      const out = execSync(`node ${cellsBin} health`, { encoding: 'utf8' });
      expect(out).toContain('✓ validate');
      expect(out).toContain('✓ crossings');
      expect(out).toContain('✓ structure');
      expect(out).toContain('✓ size');
      expect(out).toContain('All checks passed');
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

      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022', allowImportingTsExtensions: true, noEmit: true },
        }),
      );

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

      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
      writeFileSync(
        join(repo, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022', allowImportingTsExtensions: true, noEmit: true } }),
      );

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

  describe('validate is now an alias for health', () => {
    it('runs the full gate and prints a redirect note', () => {
      const out = execSync(`node ${cellsBin} validate`, { encoding: 'utf8' });
      expect(out).toContain('is now `cells health`');
      expect(out).toContain('All checks passed');
    });
  });
});
