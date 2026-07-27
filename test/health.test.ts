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
});
