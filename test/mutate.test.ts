import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cellsBin = join(__dirname, '..', 'dist', 'cli.js');

function cells(args: string[], cwd: string): string {
  return execFileSync('node', [cellsBin, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/** The write side must preserve author comments and never half-rename. */
describe('cells rename / remove --force / prune-stale (comment preservation)', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function setupRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cells-mutate-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, '.cells'), { recursive: true });
    writeFileSync(join(dir, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    return dir;
  }

  it("rename preserves comments in the renamed declaration AND in dependents' requires", () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'parser.cell.toml'), '# authored membrane — comments must survive tool rewrites\nname = "parser"\npurpose = "p" # inline note\nprovides = ["parseCell"]\nrequires = [\n  "toml", # shared codec\n]\n');
    writeFileSync(join(repo, '.cells', 'cli.cell.toml'), 'name = "cli"\npurpose = "p"\nprovides = []\nrequires = ["parser"] # depends on parsing\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[parser]\nfiles = ["src/a.ts"]\n\n[cli]\nfiles = ["src/b.ts"]\n');

    const out = cells(['rename', 'parser', 'parser2'], repo);
    expect(out).toContain('Renamed "parser" → "parser2"');

    const renamed = readFileSync(join(repo, '.cells', 'parser2.cell.toml'), 'utf8');
    expect(renamed).toContain('# authored membrane'); // comments survive the rename
    expect(renamed).toContain('# inline note');
    expect(renamed).toContain('name = "parser2"');
    expect(existsSync(join(repo, '.cells', 'parser.cell.toml'))).toBe(false); // old file gone

    const dep = readFileSync(join(repo, '.cells', 'cli.cell.toml'), 'utf8');
    expect(dep).toContain('requires = ["parser2"] # depends on parsing'); // ref renamed, comment kept

    const ownership = readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8');
    expect(ownership).toContain('[parser2]');
    expect(ownership).not.toContain('[parser]');
  });

  it("remove --force strips requires refs without eating the dependent's comments", () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'gone.cell.toml'), 'name = "gone"\npurpose = "p"\nprovides = []\nrequires = []\n');
    writeFileSync(join(repo, '.cells', 'keeper.cell.toml'), '# keeper docs\nname = "keeper"\npurpose = "p"\nprovides = []\nrequires = ["gone"]\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[gone]\nfiles = ["src/a.ts"]\n');

    cells(['remove', 'gone', '--force'], repo);
    const dep = readFileSync(join(repo, '.cells', 'keeper.cell.toml'), 'utf8');
    expect(dep).toContain('# keeper docs');
    expect(dep).not.toContain('"gone"');
  });

  it('rename refuses when an ownership-only [newName] entry exists (guard runs before any write)', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'old.cell.toml'), 'name = "old"\npurpose = "p"\nprovides = []\nrequires = []\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[old]\nfiles = ["src/a.ts"]\n\n[new]\nfiles = ["src/b.ts"]\n');
    try {
      cells(['rename', 'old', 'new'], repo);
      expect.unreachable('expected exit 1');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('[new]');
      // store untouched — no half-rename
      expect(existsSync(join(repo, '.cells', 'old.cell.toml'))).toBe(true);
      expect(existsSync(join(repo, '.cells', 'new.cell.toml'))).toBe(false);
    }
  });
});
