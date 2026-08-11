import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const cellsBin = join(__dirname, '..', 'dist', 'cli.js');

/** Minimal fixture: .cells + one src file owned by cell "a". Returns repo dir. */
function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cells-workflow-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.cells'), { recursive: true });

  writeFileSync(join(dir, 'src', 'a.ts'), `export const x = 1;\n`);
  writeFileSync(join(dir, '.cells', 'config.toml'), `code-dirs = ["src"]\n`);
  writeFileSync(join(dir, '.cells', 'a.cell.toml'), `name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = []\n`);
  writeFileSync(join(dir, '.cells', 'ownership.toml'), `[a]\nfiles = ["src/a.ts"]\n`);

  return dir;
}

describe('cells imports', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('dumps the raw import graph as JSON (edges + unresolved, same-cell included)', () => {
    repo = setupRepo();
    writeFileSync(
      join(repo, 'src', 'b.ts'),
      `import { x } from './a';
import { nope } from './nope';
export const y = x + nope;
`,
    );
    const out = execSync(`node ${cellsBin} imports --json`, { cwd: repo, encoding: 'utf8' });
    const { edges, unresolved } = JSON.parse(out);
    // same-cell edge present (a.ts → b.ts is one cell) — the validation surface, not crossings
    expect(edges).toContainEqual({ fromFile: 'src/b.ts', toFile: 'src/a.ts', import: './a' });
    expect(unresolved).toContainEqual({ fromFile: 'src/b.ts', import: './nope' });
  });
});

describe('cells new', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('scaffolds a declaration with flags; health stays green', () => {
    repo = setupRepo();
    const out = execSync(`node ${cellsBin} new db --purpose "storage" --provides query,write --requires a --layer 2`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('Created cell "db"');
    const decl = readFileSync(join(repo, '.cells', 'db.cell.toml'), 'utf8');
    expect(decl).toContain('name = "db"');
    expect(decl).toContain('purpose = "storage"');
    expect(decl).toContain('provides = ["query", "write"]');
    expect(decl).toContain('requires = ["a"]');
    expect(decl).toContain('layer = 2');
    expect(execSync(`node ${cellsBin} health`, { cwd: repo, encoding: 'utf8' })).toContain('All checks passed');
  });

  it('refuses a duplicate or invalid name', () => {
    repo = setupRepo();
    const dup = spawnSync(`node`, [cellsBin, 'new', 'a'], { cwd: repo, encoding: 'utf8' });
    expect(dup.status).toBe(1);
    expect(dup.stderr).toContain('already exists');
    const bad = spawnSync(`node`, [cellsBin, 'new', 'src/evil'], { cwd: repo, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('invalid cell name');
  });

  it('rejects flags before the name and non-decimal --layer', () => {
    repo = setupRepo();
    // flag value must never become the cell name
    const flagFirst = spawnSync(`node`, [cellsBin, 'new', '--layer', '2', 'db'], { cwd: repo, encoding: 'utf8' });
    expect(flagFirst.status).toBe(1);
    expect(flagFirst.stderr).toContain('usage: cells new');
    expect(existsSync(join(repo, '.cells', '2.cell.toml'))).toBe(false);
    // Number() laxness: hex/exponent/empty must not pass
    for (const badLayer of ['0x10', '1e3', '']) {
      const r = spawnSync(`node`, [cellsBin, 'new', 'db', '--layer', badLayer], { cwd: repo, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--layer must be a non-negative integer');
    }
  });
});

describe('cells prune-stale', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function setupStaleRepo(): string {
    const dir = setupRepo();
    // a requires b but nothing imports b — stale
    writeFileSync(join(dir, '.cells', 'a.cell.toml'), `name = "a"\npurpose = "p"\nprovides = ["x"]\nrequires = ["b"]\n`);
    writeFileSync(join(dir, '.cells', 'b.cell.toml'), `name = "b"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    return dir;
  }

  it('dry-run lists the stale require and touches nothing', () => {
    repo = setupStaleRepo();
    const out = execSync(`node ${cellsBin} prune-stale`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('1 stale require(s)');
    expect(out).toContain('a → b');
    expect(out).toContain('Dry run');
    expect(readFileSync(join(repo, '.cells', 'a.cell.toml'), 'utf8')).toContain('requires = ["b"]');
  });

  it('--apply removes it; health exits 0 with no stale info', () => {
    repo = setupStaleRepo();
    execSync(`node ${cellsBin} prune-stale --apply`, { cwd: repo, encoding: 'utf8' });
    const decl = readFileSync(join(repo, '.cells', 'a.cell.toml'), 'utf8');
    expect(decl).not.toContain('"b"');
    const res = spawnSync(`node`, [cellsBin, 'health'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain('stale');
  });
});

describe('cells config', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('reads the effective config', () => {
    repo = setupRepo();
    const out = execSync(`node ${cellsBin} config`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('max-payload-tokens = 16000'); // default where the fixture omits it
    expect(out).toContain('code-dirs = ["src"]');
  });

  it('sets max-payload-tokens in place, preserving the rest of the file', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'config.toml'), '# keep me\nmax-payload-tokens = 16000\ncode-dirs = ["src"]\n');
    const out = execSync(`node ${cellsBin} config set max-payload-tokens 24000`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('24000 (was 16000)');
    const next = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    expect(next).toContain('# keep me'); // comment survived
    expect(next).toContain('max-payload-tokens = 24000');
    expect(next).toContain('code-dirs = ["src"]'); // other keys survived
    // and health now reports against the new ceiling
    expect(execSync(`node ${cellsBin} config`, { cwd: repo, encoding: 'utf8' })).toContain('max-payload-tokens = 24000');
  });

  it('appends the key when the file lacks it; validates the value', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\n');
    execSync(`node ${cellsBin} config set max-payload-tokens 20000`, { cwd: repo, encoding: 'utf8' });
    expect(readFileSync(join(repo, '.cells', 'config.toml'), 'utf8')).toContain('max-payload-tokens = 20000');
    const bad = spawnSync(`node`, [cellsBin, 'config', 'set', 'max-payload-tokens', 'lots'], { cwd: repo, encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('positive integer');
  });
});

describe("python src-layout cold start (the griller's hole)", () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  /** Fresh fixture: src-layout python with real cross-module imports, NO module-root. */
  function setupPythonRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cells-pysrc-'));
    mkdirSync(join(dir, 'src/core'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src/core/engine.py'), 'from util import setup\n\ndef run():\n    return setup()\n');
    writeFileSync(join(dir, 'src/util.py'), 'def setup():\n    return True\n');
    writeFileSync(join(dir, 'tests/test_engine.py'), 'from core.engine import run\n\ndef test_run():\n    assert run()\n');
    // init writes the config template; module-root stays commented (the default)
    execSync(`node ${cellsBin} init`, { cwd: dir, encoding: 'utf8' });
    execSync(`node ${cellsBin} plan --apply`, { cwd: dir, encoding: 'utf8' });
    return dir;
  }

  it('REG: plan names skip-named dirs that hold real code — "0 orphans" cannot hide a swallowed package (cli internal/build stress finding)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-skip-'));
    mkdirSync(join(dir, 'internal/build'), { recursive: true });
    mkdirSync(join(dir, 'internal/ghcmd'), { recursive: true });
    writeFileSync(join(dir, 'go.mod'), 'module example\n');
    writeFileSync(join(dir, 'internal/build/build.go'), 'package build\n\nfunc X() {}\n');
    writeFileSync(join(dir, 'internal/ghcmd/cmd.go'), 'package ghcmd\n\nimport "example/internal/build"\n\nfunc Cmd() { build.X() }\n');
    execSync(`node ${cellsBin} init`, { cwd: dir, encoding: 'utf8' });
    const r = spawnSync(`node`, [cellsBin, 'plan', '--apply'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skip-named dir(s)');
    expect(r.stdout).toContain('internal/build');
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reports a silent 0-edge green gate: same-family imports resolve to REAL edges (gated), cross-family stay unresolved with a module-root hint', () => {
    repo = setupPythonRepo();
    // The griller's hole is dead twice over: `from util import setup` now RESOLVES (the
    // probe proved src/util.py exists; unique in the importer's family) — the resulting
    // crossing is undeclared, so crossings exits 1 demanding requires. The cross-family
    // `core.engine` (tests → src) stays unresolved with the module-root hint.
    const r = spawnSync(`node`, [cellsBin, 'crossings'], { cwd: repo, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1); // undeclared crossing — the edge is real and the gate demands it be declared
    expect(out).toContain('src/core/engine.py'); // the real edge renders
    expect(out).toContain('Unresolved imports that look local');
    expect(out).toContain('module-root'); // the hint, not a bare list
    // The lie is dead: no "0 edges → All checks passed" on a repo full of imports —
    // the gate is now RED on the undeclared crossing, and the unresolved remain visible.
    const h = spawnSync(`node`, [cellsBin, 'health'], { cwd: repo, encoding: 'utf8' });
    expect(h.status).toBe(1);
    expect(h.stdout + h.stderr).toContain('unresolved');
  });

  it('REG: crossings --warnings skips the pair listing — leakage + unresolved only (stress feedback: warnings drown on big repos)', () => {
    repo = setupPythonRepo();
    const r = spawnSync(`node`, [cellsBin, 'crossings', '--warnings'], { cwd: repo, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1); // the gate still fires on undeclared crossings
    expect(out).not.toContain('Cross-cell imports'); // no listing
    expect(out).toContain('Undeclared crossings'); // actionable tail only
    expect(out).toContain('Unresolved imports that look local');
    expect(out).toContain('module-root');
  });

  it('setting module-root turns the unresolved imports into real edges (the intended fix)', () => {
    repo = setupPythonRepo();
    const cfg = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    writeFileSync(join(repo, '.cells', 'config.toml'), cfg.replace('# module-root = "src"', 'module-root = "src"'));
    // Edges exist now — undeclared crossings are a GATE (exit 1): spawnSync, assert on the report.
    const r = spawnSync(`node`, [cellsBin, 'crossings'], { cwd: repo, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    expect(out).toContain('src/core/engine.py'); // edges now exist (undeclared-crossings rows)
    expect(out).not.toContain('Unresolved imports that look local');
  });
});

describe('cells health --verbose', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('names the failing undeclared edge inline (exit 1)', () => {
    repo = setupRepo();
    writeFileSync(join(repo, 'src', 'b.ts'), `import { x } from './a.js';\n`);
    writeFileSync(join(repo, '.cells', 'b.cell.toml'), `name = "b"\npurpose = "p"\nprovides = []\nrequires = []\n`);
    writeFileSync(join(repo, '.cells', 'ownership.toml'), `[a]\nfiles = ["src/a.ts"]\n[b]\nfiles = ["src/b.ts"]\n`);
    const res = spawnSync(`node`, [cellsBin, 'health', '--verbose'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('1 undeclared');
    expect(res.stdout).toContain('b imports a (src/b.ts → src/a.ts)');
    // default stays terse — no inline edges
    const terse = spawnSync(`node`, [cellsBin, 'health'], { cwd: repo, encoding: 'utf8' });
    expect(terse.stdout).not.toContain('imports a (');
  });

  it('--verbose passes through on a healthy repo', () => {
    repo = setupRepo();
    const res = spawnSync(`node`, [cellsBin, 'health', '--verbose'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('All checks passed');
  });
});

describe('cells show per-file tokens', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('lists each owned file with its token weight', () => {
    repo = setupRepo();
    const out = execSync(`node ${cellsBin} show a`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('src/a.ts');
    expect(out).toMatch(/src\/a\.ts\s+\(~\d+ tok\)/);
  });

  it('cells new + assign completes the split loop end to end', () => {
    repo = setupRepo();
    writeFileSync(join(repo, 'src', 'big.ts'), `export const y = ${'1'.repeat(300)};\n`);
    execSync(`node ${cellsBin} new big --purpose "second cell" --requires a`, { cwd: repo, encoding: 'utf8' });
    expect(existsSync(join(repo, '.cells', 'big.cell.toml'))).toBe(true);
    execSync(`node ${cellsBin} assign big src/big.ts`, { cwd: repo, encoding: 'utf8' });
    const out = execSync(`node ${cellsBin} show big`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('src/big.ts');
    expect(execSync(`node ${cellsBin} health`, { cwd: repo, encoding: 'utf8' })).toContain('All checks passed');
  });
});
