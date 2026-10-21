import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveCrossings } from '../src/crossings.js';
import { crossingsDelta, recentCommitFiles } from '../src/diff.js';
import { collectImportEdges } from '../src/importers.js';
import type { Ownership } from '../src/ownership.js';

// `crossingsDelta` drives the real pipeline: extraction of the HEAD tree, a new collection of
// the import edges, `deriveCrossings`, and the diff. Therefore this is an integration test
// against a throwaway git repository. `working` comes from the same `collectImportEdges` that
// the CLI uses. The unit under test is the HEAD side and the diff, which is exactly what
// `diff` owns.
const startCwd = process.cwd();
let repo: string;

function git(args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
}

/** Two cells: a owns src/a.ts, and b owns src/b.ts and requires a. The repository has a committed HEAD. */
function setupRepo(): void {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.cells'), { recursive: true });
  writeFileSync(join(repo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = ["a"]\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n');
  // The code-dirs value limits the census to src. The defaults include `test`, which does not exist here.
  writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
}

const ownership: Ownership = { a: ['src/a.ts'], b: ['src/b.ts'] };

describe('crossingsDelta', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-diff-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports an added crossing when the working tree adds a cross-cell import', async () => {
    setupRepo();
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const y = 2;\n'); // HEAD has no import.
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // The working tree adds the b -> a crossing.
    writeFileSync(join(repo, 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n");
    const { edges } = await collectImportEdges();
    const working = deriveCrossings(edges, ownership);
    const delta = await crossingsDelta(working, ownership);
    expect(delta).not.toBeNull();
    expect(delta!.added).toHaveLength(1);
    expect(delta!.added[0]).toMatchObject({ fromCell: 'b', toCell: 'a' });
    expect(delta!.removed).toHaveLength(0);
  });

  it('reports a removed crossing when the working tree drops a cross-cell import', async () => {
    setupRepo();
    writeFileSync(join(repo, 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n"); // HEAD has the import.
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // The working tree removes the b -> a crossing.
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const y = 2;\n');
    const { edges } = await collectImportEdges();
    const working = deriveCrossings(edges, ownership);
    const delta = await crossingsDelta(working, ownership);
    expect(delta).not.toBeNull();
    expect(delta!.removed).toHaveLength(1);
    expect(delta!.removed[0]).toMatchObject({ fromCell: 'b', toCell: 'a' });
    expect(delta!.added).toHaveLength(0);
  });

  it('returns null outside a git repo (caller degrades to the current view)', async () => {
    setupRepo();
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const y = 2;\n');
    // There is no git init, so isGitRepo() is false.
    const delta = await crossingsDelta([], ownership);
    expect(delta).toBeNull();
  });
});

describe('cells crossings --diff (CLI)', () => {
  const cellsBin = join(__dirname, '..', 'dist', 'cli.js');
  let cliRepo: string;

  afterEach(() => {
    if (cliRepo) rmSync(cliRepo, { recursive: true, force: true });
  });

  function git(args: string): void {
    execSync(`git ${args}`, { cwd: cliRepo, stdio: 'ignore' });
  }

  it('marks an undeclared added edge inline as [UNDECLARED]', () => {
    cliRepo = mkdtempSync(join(tmpdir(), 'cells-diff-cli-'));
    mkdirSync(join(cliRepo, 'src'), { recursive: true });
    mkdirSync(join(cliRepo, '.cells'), { recursive: true });
    // The cell b does not require a, so the b -> a edge is undeclared.
    writeFileSync(join(cliRepo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
    writeFileSync(join(cliRepo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = []\nrequires = []\nlayer = 0\n');
    writeFileSync(join(cliRepo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n');
    writeFileSync(join(cliRepo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
    writeFileSync(join(cliRepo, 'src', 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(cliRepo, 'src', 'b.ts'), 'export const y = 2;\n'); // HEAD has no import.
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // The working tree adds an UNDECLARED b -> a crossing.
    writeFileSync(join(cliRepo, 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n");

    try {
      execSync(`node ${cellsBin} crossings --diff`, { cwd: cliRepo, encoding: 'utf8', stdio: 'pipe' });
      expect.unreachable('expected exit 1');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stdout).toContain('+ [UNDECLARED] b → a');
      expect(err.stderr).toContain('add "a" to b.cell.toml requires');
    }
  });

  it('marks a removed edge still declared in requires as [REQUIRES NOW STALE]', () => {
    cliRepo = mkdtempSync(join(tmpdir(), 'cells-diff-cli-'));
    mkdirSync(join(cliRepo, 'src'), { recursive: true });
    mkdirSync(join(cliRepo, '.cells'), { recursive: true });
    // The cell b requires a, so to remove the b -> a edge makes the declared requirement stale.
    writeFileSync(join(cliRepo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
    writeFileSync(join(cliRepo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = []\nrequires = ["a"]\nlayer = 0\n');
    writeFileSync(join(cliRepo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n');
    writeFileSync(join(cliRepo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
    writeFileSync(join(cliRepo, 'src', 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(cliRepo, 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n"); // HEAD has the import.
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // The working tree removes the b -> a crossing, but requires still lists a.
    writeFileSync(join(cliRepo, 'src', 'b.ts'), 'export const y = 2;\n');

    const out = execSync(`node ${cellsBin} crossings --diff`, { cwd: cliRepo, encoding: 'utf8' });
    expect(out).toContain('− [REQUIRES NOW STALE] b → a');
  });
});

describe('recentCommitFiles', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cells-couchange-'));
    process.chdir(repo);
  });
  afterEach(() => {
    process.chdir(startCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns the window commits with FULL per-commit file lists (union math needs every file)', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b\n');
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m one'); // Commit one changes a and b together, because both files are new.
    writeFileSync(join(repo, 'src', 'a.ts'), 'a2\n');
    writeFileSync(join(repo, 'src', 'c.ts'), 'c\n');
    git('add -A');
    git('commit -m two'); // Commit two changes a and c together.
    const commits = recentCommitFiles(['src/a.ts'], 10);
    expect(commits).toHaveLength(2); // both commits touched src/a.ts
    expect(commits[0]).toMatchObject({ files: expect.arrayContaining(['src/a.ts', 'src/c.ts']) });
    expect(commits[1]).toMatchObject({ files: expect.arrayContaining(['src/a.ts', 'src/b.ts']) });
  });

  it('honors the window limit and the owned-files pathspec', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b\n');
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m one');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b2\n');
    git('add -A');
    git('commit -m two'); // The commit changes only b, which is outside the a path.
    writeFileSync(join(repo, 'src', 'a.ts'), 'a2\n');
    git('add -A');
    git('commit -m three');
    expect(recentCommitFiles(['src/a.ts'], 1)).toHaveLength(1); // The limit applies.
    expect(recentCommitFiles(['src/a.ts'], 10)).toHaveLength(2); // The path limits the result to the commits that touch a.
  });

  it('sees min(limit, depth) on a shallow clone — the graceful window', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m one');
    writeFileSync(join(repo, 'src', 'a.ts'), 'a2\n');
    git('add -A');
    git('commit -m two');
    writeFileSync(join(repo, 'src', 'a.ts'), 'a3\n');
    git('add -A');
    git('commit -m three');
    const shallow = mkdtempSync(join(tmpdir(), 'cells-shallow-'));
    try {
      execSync(`git clone --depth 2 file://${repo} ${join(shallow, 'c')}`, { stdio: 'ignore' });
      const before = process.cwd();
      process.chdir(join(shallow, 'c'));
      try {
        expect(recentCommitFiles(['src/a.ts'], 10)).toHaveLength(2); // The depth is 2 and not the requested 10.
      } finally {
        process.chdir(before);
      }
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });

  it('returns [] outside a git repo and for empty owned lists', () => {
    expect(recentCommitFiles(['src/a.ts'])).toEqual([]);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m one');
    expect(recentCommitFiles([])).toEqual([]);
  });
});
