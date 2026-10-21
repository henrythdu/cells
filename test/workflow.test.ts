import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cellsBin = join(__dirname, '..', 'dist', 'cli.js');

/** A minimal fixture: a .cells directory and one source file that cell "a" owns. The function returns the repository directory. */
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
    // The same-cell edge is present, because a.ts and b.ts are in one cell. This is the
    // validation surface and not the crossings.
    expect(edges).toContainEqual({ fromFile: 'src/b.ts', toFile: 'src/a.ts', import: './a', symbols: ['x'] });
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
    // A flag value must never become the cell name.
    const flagFirst = spawnSync(`node`, [cellsBin, 'new', '--layer', '2', 'db'], { cwd: repo, encoding: 'utf8' });
    expect(flagFirst.status).toBe(1);
    expect(flagFirst.stderr).toContain('usage: cells new');
    expect(existsSync(join(repo, '.cells', '2.cell.toml'))).toBe(false);
    // The loose behavior of Number() must not accept hex, exponent, or empty values.
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
    // The cell a requires b, but nothing imports b. The requirement is stale.
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
    expect(out).toContain('max-payload-tokens = 16000'); // The default value, because the fixture omits the key.
    expect(out).toContain('code-dirs = ["src"]');
  });

  it('sets max-payload-tokens in place, preserving the rest of the file', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'config.toml'), '# keep me\nmax-payload-tokens = 16000\ncode-dirs = ["src"]\n');
    const out = execSync(`node ${cellsBin} config set max-payload-tokens 24000`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('24000 (was 16000)');
    const next = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    expect(next).toContain('# keep me'); // The comment stays.
    expect(next).toContain('max-payload-tokens = 24000');
    expect(next).toContain('code-dirs = ["src"]'); // The other keys stay.
    // The config command now reports the new ceiling.
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

  it('replaces an indented or commented key instead of appending a duplicate', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'config.toml'), '  max-payload-tokens = 16_000 # budget\ncode-dirs = ["src"]\n');
    execSync(`node ${cellsBin} config set max-payload-tokens 20000`, { cwd: repo, encoding: 'utf8' });
    const next = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    expect(next.match(/max-payload-tokens/g)).toHaveLength(1);
    expect(next).toContain('code-dirs = ["src"]');
    expect(execSync(`node ${cellsBin} config`, { cwd: repo, encoding: 'utf8' })).toContain('max-payload-tokens = 20000');
  });

  it('inserts above a trailing [layers] table and repairs a duplicated key', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\nmax-payload-tokens = 16000\nmax-payload-tokens = 17000\n\n[layers]\n0 = "core"\n');
    execSync(`node ${cellsBin} config set max-payload-tokens 20000`, { cwd: repo, encoding: 'utf8' });
    const next = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    expect(next.match(/max-payload-tokens/g)).toHaveLength(1);
    expect(next).toContain('[layers]');
    // The key must not sit inside the layers table, where it would be an unknown layer name.
    expect(next.indexOf('max-payload-tokens')).toBeLessThan(next.indexOf('[layers]'));
    const read = execSync(`node ${cellsBin} config`, { cwd: repo, encoding: 'utf8' });
    expect(read).toContain('max-payload-tokens = 20000');
    expect(read).toContain('layers');
  });

  it('moves a key that an older version wrote inside the [layers] table back to the top level', () => {
    repo = setupRepo();
    // This is the exact residue of the old append: the only key sits under the header, so the
    // effective ceiling stayed at the default while `set` reported success.
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["src"]\n\n[layers]\n0 = "core"\nmax-payload-tokens = 16000\n');
    // The warning that the repair must not print goes to stderr, so capture it: stdout alone
    // would make the last assertion below unable to fail.
    const set = spawnSync('node', [cellsBin, 'config', 'set', 'max-payload-tokens', '20000'], { cwd: repo, encoding: 'utf8' });
    expect(set.status).toBe(0);
    expect(set.stderr).not.toContain('non-numeric key');
    const next = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    expect(next.match(/max-payload-tokens/g)).toHaveLength(1);
    expect(next.indexOf('max-payload-tokens')).toBeLessThan(next.indexOf('[layers]'));
    const read = execSync(`node ${cellsBin} config`, { cwd: repo, encoding: 'utf8' });
    expect(read).toContain('max-payload-tokens = 20000');
  });

  it('refuses with exit 1 and leaves the file untouched when the result does not parse', () => {
    repo = setupRepo();
    // An unclosed array is not something this command repairs, so it must not report success,
    // and a failed command must not change the file.
    const original = 'code-dirs = ["src"\nmax-payload-tokens = 16000\n';
    writeFileSync(join(repo, '.cells', 'config.toml'), original);
    const set = spawnSync('node', [cellsBin, 'config', 'set', 'max-payload-tokens', '20000'], { cwd: repo, encoding: 'utf8' });
    expect(set.status).toBe(1);
    expect(set.stderr).toContain('still invalid');
    expect(readFileSync(join(repo, '.cells', 'config.toml'), 'utf8')).toBe(original);
  });

  it('strips a byte-order mark and writes a config that parses', () => {
    repo = setupRepo();
    writeFileSync(join(repo, '.cells', 'config.toml'), '\uFEFFmax-payload-tokens = 16000\ncode-dirs = ["src"]\n');
    const set = spawnSync('node', [cellsBin, 'config', 'set', 'max-payload-tokens', '20000'], { cwd: repo, encoding: 'utf8' });
    expect(set.status).toBe(0);
    const next = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    expect(next.startsWith('max-payload-tokens')).toBe(true);
    expect(execSync(`node ${cellsBin} config`, { cwd: repo, encoding: 'utf8' })).toContain('max-payload-tokens = 20000');
  });
});

describe('python src-layout cold start', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  /** A new fixture: a Python src layout with real imports between modules and NO module-root. */
  function setupPythonRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cells-pysrc-'));
    mkdirSync(join(dir, 'src/core'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src/core/engine.py'), 'from util import setup\n\ndef run():\n    return setup()\n');
    writeFileSync(join(dir, 'src/util.py'), 'def setup():\n    return True\n');
    writeFileSync(join(dir, 'tests/test_engine.py'), 'from core.engine import run\n\ndef test_run():\n    assert run()\n');
    // init writes the config template. The module-root key stays commented, which is the default.
    execSync(`node ${cellsBin} init`, { cwd: dir, encoding: 'utf8' });
    execSync(`node ${cellsBin} plan --apply`, { cwd: dir, encoding: 'utf8' });
    return dir;
  }

  it('plan names skip-named dirs that hold real code — "0 orphans" cannot hide a swallowed package', () => {
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
    // This is a src-layout cold start, checked in two ways. `from util import setup` now
    // RESOLVES: the probe proved that src/util.py exists and is unique in the family of the
    // importer. The crossing is therefore undeclared, and `crossings` exits with code 1 and
    // demands requires. The cross-family import `core.engine` (tests -> src) stays unresolved
    // with the module-root hint.
    const r = spawnSync(`node`, [cellsBin, 'crossings'], { cwd: repo, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1); // The crossing is undeclared. The edge is real, and the gate demands a declaration.
    expect(out).toContain('src/core/engine.py'); // The real edge appears.
    expect(out).toContain('Unresolved imports that look local');
    expect(out).toContain('module-root'); // The hint appears, not a bare list.
    // The false success is gone: no "0 edges -> All checks passed" in a repository full of
    // imports. The gate now FAILS on the undeclared crossing, and the unresolved imports stay
    // visible.
    const h = spawnSync(`node`, [cellsBin, 'health'], { cwd: repo, encoding: 'utf8' });
    expect(h.status).toBe(1);
    expect(h.stdout + h.stderr).toContain('unresolved');
  });

  it('crossings --warnings skips the pair listing — leakage + unresolved only', () => {
    repo = setupPythonRepo();
    const r = spawnSync(`node`, [cellsBin, 'crossings', '--warnings'], { cwd: repo, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1); // The gate still fails on undeclared crossings.
    expect(out).not.toContain('Cross-cell imports'); // There is no listing.
    expect(out).toContain('Undeclared crossings'); // Only the actionable tail appears.
    expect(out).toContain('Unresolved imports that look local');
    expect(out).toContain('module-root');
  });

  it('setting module-root turns the unresolved imports into real edges (the intended fix)', () => {
    repo = setupPythonRepo();
    const cfg = readFileSync(join(repo, '.cells', 'config.toml'), 'utf8');
    writeFileSync(join(repo, '.cells', 'config.toml'), cfg.replace('# module-root = "src"', 'module-root = "src"'));
    // The edges exist now. An undeclared crossing is a GATE (exit 1), so the test uses
    // spawnSync and asserts on the report.
    const r = spawnSync(`node`, [cellsBin, 'crossings'], { cwd: repo, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1); // Undeclared crossings are a gate, so the resolved edges must FAIL it.
    expect(out).toContain('src/core/engine.py'); // The edges exist now, and the undeclared-crossing rows show them.
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
    // The default stays terse, with no inline edges.
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

  it('assign dedupes symlink aliases — same inode owned twice is impossible', () => {
    repo = setupRepo();
    // The census sees both paths, because the file is a symlink. Ownership holds the real path.
    mkdirSync(join(repo, 'real'), { recursive: true });
    mkdirSync(join(repo, 'alias'), { recursive: true });
    writeFileSync(join(repo, 'real', 'atom.ts'), 'export const atom = 1;\n');
    symlinkSync(join(repo, 'real', 'atom.ts'), join(repo, 'alias', 'atom.ts'));
    writeFileSync(join(repo, '.cells', 'config.toml'), 'code-dirs = ["."]\n');
    writeFileSync(join(repo, '.cells', 'ownership.toml'), '[a]\nfiles = ["real/atom.ts"]\n');
    // To assign the alias path must reuse the real-path entry and must not create a second owner.
    const out = execSync(`node ${cellsBin} assign b alias/atom.ts`, { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('symlink alias');
    const own = readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8');
    expect(own).not.toContain('alias/atom.ts');
    expect(own).toContain('real/atom.ts');
    expect(own.match(/real\/atom\.ts/g)).toHaveLength(1); // There is one entry, and it moved to b.
    expect(execSync(`node ${cellsBin} health`, { cwd: repo, encoding: 'utf8' })).toContain('All checks passed');
    // A second assign of the alias does nothing and writes a note. The entry is still one.
    const again = execSync(`node ${cellsBin} assign b alias/atom.ts`, { cwd: repo, encoding: 'utf8' });
    expect(again).toContain('already owned');
    expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8').match(/real\/atom\.ts/g)).toHaveLength(1);
  });

  it('assign refuses a directory with a hint — no literal ownership entry', () => {
    repo = setupRepo();
    mkdirSync(join(repo, 'web'), { recursive: true });
    writeFileSync(join(repo, 'web', 'a.ts'), `export const z = 1;\n`);
    const res = spawnSync(`node`, [cellsBin, 'assign', 'a', 'web/'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('is a directory');
    expect(res.stderr).toContain('assign takes files');
    // Nothing was written, so ownership is unchanged and there is no dangling entry.
    expect(readFileSync(join(repo, '.cells', 'ownership.toml'), 'utf8')).not.toContain('web/');
    // The function also refuses a missing path.
    const miss = spawnSync(`node`, [cellsBin, 'assign', 'a', 'nope.ts'], { cwd: repo, encoding: 'utf8' });
    expect(miss.status).toBe(1);
    expect(miss.stderr).toContain('no such file');
  });
});

describe('cli dispatcher', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('rejects a single-dash unknown flag (previously bypassed the gate with a misleading error)', () => {
    repo = setupRepo();
    const res = spawnSync(`node`, [cellsBin, 'list', '-x'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown flag "-x"');
  });

  it('rejects --dry-run on a command that does not declare it (the flag silently vanished instead)', () => {
    repo = setupRepo();
    const res = spawnSync(`node`, [cellsBin, 'crossings', '--dry-run'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown flag "--dry-run"');
  });

  it('treats everything after -- as a literal positional (end-of-flags)', () => {
    repo = setupRepo();
    // The file has a name that looks like a flag, and it is unreachable without `--`.
    const res = spawnSync(`node`, [cellsBin, 'owns', '--', 'src/a.ts'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('a');
  });

  it('a bare trailing `--` is an empty positional tail (accepted, harmless)', () => {
    repo = setupRepo();
    const res = spawnSync(`node`, [cellsBin, 'list', '--'], { cwd: repo, encoding: 'utf8' });
    expect(res.status).toBe(0);
  });
});
