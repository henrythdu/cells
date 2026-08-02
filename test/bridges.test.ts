import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBridgeMap, applyBridges, scanCdylibCrates } from '../src/bridges.js';

let tmp: string | null = null;
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** A pyo3-shaped fixture: root pyproject.toml ([tool.maturin] module-name) + a cdylib
 *  crate at crates/headroom-py/ whose lib name is the module tail. Returns the tmpdir. */
function setupPyo3Fixture(): string {
  tmp = mkdtempSync(join(tmpdir(), 'cells-bridge-'));
  mkdirSync(join(tmp, 'crates', 'headroom-py', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'pyproject.toml'), '[tool.maturin]\nmodule-name = "headroom._core"\n');
  writeFileSync(join(tmp, 'crates', 'headroom-py', 'Cargo.toml'), '[package]\nname = "headroom-py"\n\n[lib]\nname = "_core"\ncrate-type = ["cdylib"]\n');
  writeFileSync(join(tmp, 'crates', 'headroom-py', 'src', 'lib.rs'), '#[pymodule]\n');
  return tmp;
}

describe('scanCdylibCrates', () => {
  it('finds the cdylib crate with lib name + entry file', () => {
    const dir = setupPyo3Fixture();
    const crates = scanCdylibCrates(['.'], dir);
    expect(crates).toEqual([{ tail: '_core', entry: 'crates/headroom-py/src/lib.rs' }]);
  });

  it('ignores non-cdylib crates (no bridge — conservative)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-bridge-'));
    tmp = dir;
    mkdirSync(join(dir, 'crates', 'plain', 'src'), { recursive: true });
    writeFileSync(join(dir, 'crates', 'plain', 'Cargo.toml'), '[package]\nname = "plain"\n\n[lib]\nname = "plain"\ncrate-type = ["lib"]\n');
    expect(scanCdylibCrates(['.'], dir)).toEqual([]);
  });
});

describe('buildBridgeMap', () => {
  it('full-name override bridges (headroom case)', () => {
    const dir = setupPyo3Fixture();
    const map = buildBridgeMap(['.'], dir);
    expect(map.get('headroom._core')).toBe('crates/headroom-py/src/lib.rs');
  });

  it('no module-name declaration: no bridge (conservative — uv deptry fixture lesson)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-bridge-'));
    tmp = dir;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), '[lib]\nname = "native_ops"\ncrate-type = ["cdylib"]\n');
    writeFileSync(join(dir, 'src', 'lib.rs'), '');
    expect(buildBridgeMap(['.'], dir).size).toBe(0);
  });

  it('empty map when no cdylib crate exists (zero behavior change)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-bridge-'));
    tmp = dir;
    writeFileSync(join(dir, 'main.py'), 'x = 1\n');
    expect(buildBridgeMap(['.'], dir).size).toBe(0);
  });
});

describe('applyBridges', () => {
  const map = new Map([
    ['headroom._core', 'crates/headroom-py/src/lib.rs'],
    ['native_ops', 'src/lib.rs'],
  ]);
  const tmpDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-bridge-'));
    tmp = dir;
    mkdirSync(join(dir, 'crates', 'headroom-py', 'src'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'crates', 'headroom-py', 'src', 'lib.rs'), '');
    writeFileSync(join(dir, 'src', 'lib.rs'), '');
    return dir;
  };

  it('resolves a full-name match to the crate entry', () => {
    const dir = tmpDir();
    const { edges, unresolved } = applyBridges(map, [{ fromFile: 'headroom/transforms/diff_compressor.py', import: 'headroom._core' }], dir);
    expect(edges).toEqual([{ fromFile: 'headroom/transforms/diff_compressor.py', toFile: 'crates/headroom-py/src/lib.rs', import: 'headroom._core' }]);
    expect(unresolved).toEqual([]);
  });

  it('does not tail-match: an unrelated cdylib lib name colliding with an import tail stays unresolved', () => {
    const dir = tmpDir();
    const { edges, unresolved } = applyBridges(map, [{ fromFile: 'pkg/foo.py', import: 'myapp.native_ops' }], dir);
    expect(edges).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });

  it('does not touch imports that match nothing (broken local stays unresolved)', () => {
    const dir = tmpDir();
    const { edges, unresolved } = applyBridges(map, [{ fromFile: 'a.py', import: 'no_such_module' }], dir);
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([{ fromFile: 'a.py', import: 'no_such_module' }]);
  });

  it('drops the bridge when the entry file does not exist (honest — no dead edges)', () => {
    const dir = tmpDir();
    const { edges, unresolved } = applyBridges(new Map([['gone.mod', 'crates/none/src/lib.rs']]), [{ fromFile: 'a.py', import: 'gone.mod' }], dir);
    expect(edges).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });

  it('empty map returns everything unresolved untouched', () => {
    const dir = tmpDir();
    const { edges, unresolved } = applyBridges(new Map(), [{ fromFile: 'a.py', import: 'x.y' }], dir);
    expect(edges).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });
});
