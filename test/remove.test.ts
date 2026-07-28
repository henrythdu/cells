import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const cellsBin = join(__dirname, '..', 'dist', 'cli.js');

function cells(args: string[], cwd: string): string {
  return execFileSync('node', [cellsBin, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

describe('cells remove', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cells-remove-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, '.cells'), { recursive: true });
    writeFileSync(join(dir, '.cells', 'config.toml'), `code-dirs = ["src"]\n`);
    return dir;
  }

  it('errors on a nonexistent cell', () => {
    repo = setupRepo();
    try {
      cells(['remove', 'ghost'], repo);
      expect.unreachable('expected exit 1');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('no cell named "ghost"');
    }
  });

  it('removes an empty, unreferenced cell cleanly', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'lone.cell.toml'), `name = "lone"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'other.cell.toml'), `name = "other"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'ownership.toml'), `[other]\nfiles = ["src/a.ts"]\n`);

    const out = cells(['remove', 'lone'], repo);
    expect(out).toContain('Removed cell "lone"');
    expect(existsSync(join(repo, '.cells', 'lone.cell.toml'))).toBe(false);
    expect(readFileSync(join(repo, '.cells', 'other.cell.toml'), 'utf8')).toContain('name = "other"');
  });

  it('refuses to remove a cell that owns files, with hint', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'busy.cell.toml'), `name = "busy"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'ownership.toml'), `[busy]\nfiles = ["src/a.ts"]\n`);

    try {
      cells(['remove', 'busy'], repo);
      expect.unreachable('expected exit 1');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('1 file');
      expect(err.stderr).toContain('--force');
      expect(existsSync(join(repo, '.cells', 'busy.cell.toml'))).toBe(true);
    }
  });

  it('refuses to remove a cell required by others, with hint', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'dep.cell.toml'), `name = "dep"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'user.cell.toml'), `name = "user"\npurpose = "p"\nprovides = []\nrequires = ["dep"]\n`);
    writeFileSync(join(repo, '.cells', 'ownership.toml'), `\n`);

    try {
      cells(['remove', 'dep'], repo);
      expect.unreachable('expected exit 1');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('required by user');
      expect(err.stderr).toContain('--force');
      expect(existsSync(join(repo, '.cells', 'dep.cell.toml'))).toBe(true);
    }
  });

  it('--force removes declaration, orphans files, strips requires from other cells', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'dep.cell.toml'), `name = "dep"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'user.cell.toml'), `name = "user"\npurpose = "p"\nprovides = []\nrequires = ["dep", "other"]\n`);
    writeFileSync(join(repo, '.cells', 'other.cell.toml'), `name = "other"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'ownership.toml'), `[dep]\nfiles = ["src/a.ts", "src/b.ts"]\n[other]\nfiles = ["src/c.ts"]\n`);

    const out = cells(['remove', 'dep', '--force'], repo);
    expect(out).toContain('Removed cell "dep"');
    expect(existsSync(join(repo, '.cells', 'dep.cell.toml'))).toBe(false);

    const own = readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8');
    expect(own).not.toContain('[dep]');
    expect(own).toContain('[other]');

    const user = readFileSync(join(repo, '.cells', 'user.cell.toml'), 'utf8');
    expect(user).toContain('requires = ["other"]');
  });
});
