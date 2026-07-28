import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { crossingsDelta } from '../src/diff.js';
import { collectImportEdges } from '../src/importers.js';
import { deriveCrossings } from '../src/crossings.js';
import type { Ownership } from '../src/ownership.js';

// crossingsDelta drives the real pipeline (git HEAD extraction + dep-cruiser edge
// re-collection + deriveCrossings + diff), so this is an integration test against a
// throwaway git repo. `working` is derived through the same collectImportEdges the CLI
// uses — the unit under test is the HEAD side + the diff, exactly what diff owns.
const startCwd = process.cwd();
let repo: string;

function git(args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
}

/** Two cells — a (owns src/a.ts), b (owns src/b.ts, requires a) — + a committed HEAD. */
function setupRepo(): void {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.cells'), { recursive: true });
  // dep-cruiser needs TS resolution context to map './a.js' → a.ts; without these it
  // throws (silently caught → no edges), so both sides come back empty.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
  writeFileSync(
    join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022', allowImportingTsExtensions: true, noEmit: true },
    }),
  );
  writeFileSync(join(repo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = ["y"]\nrequires = ["a"]\nlayer = 0\n');
  writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n');
  // code-dirs scoped to src only — defaults include `test`, which doesn't exist here and
  // makes dep-cruiser throw ENOENT (silently caught → no edges).
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
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const y = 2;\n'); // HEAD: no import
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // working: b.ts now imports a.ts → adds a b→a crossing
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
    writeFileSync(join(repo, 'src', 'b.ts'), "import { x } from './a.js';\nexport const y = x;\n"); // HEAD: has import
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // working: b.ts drops the import → removes the b→a crossing
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
    // no git init — isGitRepo() is false
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
    writeFileSync(join(cliRepo, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));
    writeFileSync(
      join(cliRepo, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022', allowImportingTsExtensions: true, noEmit: true } }),
    );
    // b does NOT require a → the b→a edge will be undeclared
    writeFileSync(join(cliRepo, '.cells', 'a.cell.toml'), 'name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\nlayer = 0\n');
    writeFileSync(join(cliRepo, '.cells', 'b.cell.toml'), 'name = "b"\npurpose = "p"\nprovides = []\nrequires = []\nlayer = 0\n');
    writeFileSync(join(cliRepo, '.cells', 'ownership.toml'), '[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n');
    writeFileSync(join(cliRepo, '.cells', 'config.toml'), 'code-dirs = ["src"]\ncode-exts = [".ts"]\n');
    writeFileSync(join(cliRepo, 'src', 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(cliRepo, 'src', 'b.ts'), 'export const y = 2;\n'); // HEAD: no import
    git('init');
    git('config user.email t@t');
    git('config user.name t');
    git('add -A');
    git('commit -m head');
    // working: b.ts now imports a.ts → adds an UNDECLARED b→a crossing
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
});
