import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SourceFile } from '../../src/imports.js';
import { fileToModule, goImporter, modulePathsOf, resolvePackageImport } from '../../src/languages/go.js';
import { getGrammarParser } from '../../src/languages/tree-sitter.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Create a tmpdir holding a go.mod — the importer probes the FS for the module root (like
 *  rust's Cargo.toml walk), so extract-level tests need a real one on disk. */
function makeGoModule(modulePath: string): string {
  const dir = join(tmpdir(), `cells-go-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'go.mod'), `module ${modulePath}\n`);
  tmpDirs.push(dir);
  return dir;
}

/** Run the importer with cwd inside a tmpdir holding a go.mod. */
async function extractInModule(modulePath: string, files: SourceFile[]) {
  const dir = makeGoModule(modulePath);
  const startCwd = process.cwd();
  try {
    process.chdir(dir);
    return await goImporter.extract({ codeDirs: ['.'], files });
  } finally {
    process.chdir(startCwd);
  }
}

describe('fileToModule', () => {
  it('derives package keys from file paths under a module', () => {
    const repo = makeGoModule('example.com/proj');
    expect(fileToModule('main.go', undefined, repo)).toBe('example.com/proj');
    expect(fileToModule('pkg/foo.go', undefined, repo)).toBe('example.com/proj::pkg');
    expect(fileToModule('pkg/foo/bar.go', undefined, repo)).toBe('example.com/proj::pkg::foo');
    expect(fileToModule('pkg/foo/z_test.go', undefined, repo)).toBe('example.com/proj::pkg::foo'); // same package
    expect(fileToModule('internal/thing.go', undefined, repo)).toBe('example.com/proj::internal');
  });

  it('finds the nearest go.mod (nested module root)', () => {
    const repo = makeGoModule('example.com/proj');
    mkdirSync(join(repo, 'sub', 'deep'), { recursive: true });
    expect(fileToModule('sub/deep/x.go', undefined, repo)).toBe('example.com/proj::sub::deep');
  });

  it('no go.mod → dir ::-joined keys (GOPATH layout)', () => {
    expect(fileToModule('github.com/me/proj/pkg/x.go', undefined, '.')).toBe('github.com::me::proj::pkg');
    expect(fileToModule('x.go', undefined, '.')).toBe('__root__');
  });
});

describe('resolvePackageImport', () => {
  // a module'd repo — every key's first segment is the go.mod module path
  const m2f = new Map<string, string>([
    ['example.com/proj', 'main.go'],
    ['example.com/proj::pkg', 'pkg/foo.go'],
    ['example.com/proj::pkg::foo', 'pkg/foo/bar.go'],
    ['example.com/proj::internal', 'internal/thing.go'],
  ]);
  const paths = modulePathsOf(m2f);
  // a no-module (GOPATH) repo — first segments are top-level dirs
  const gopathM2f = new Map<string, string>([['github.com::me::proj::pkg', 'github.com/me/proj/pkg/x.go']]);
  const gopathPaths = modulePathsOf(gopathM2f);

  it('resolves module-relative imports to the package file', () => {
    expect(resolvePackageImport('example.com/proj/pkg', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: 'pkg/foo.go',
      local: true,
    });
    expect(resolvePackageImport('example.com/proj/pkg/foo', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: 'pkg/foo/bar.go',
      local: true,
    });
    expect(resolvePackageImport('example.com/proj', 'example.com/proj', m2f, paths)).toEqual({
      toFile: 'main.go',
      local: true, // importing the module's root package from within it
    });
  });

  it('flags local misses as unresolved, silently skips externals', () => {
    expect(resolvePackageImport('example.com/proj/pkg/missing', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: null,
      local: true, // module-prefixed → a broken local import, the LLM's to read
    });
    expect(resolvePackageImport('fmt', 'example.com/proj::pkg', m2f, paths)).toEqual({ toFile: null, local: false });
    expect(resolvePackageImport('github.com/other/x', 'example.com/proj::pkg', m2f, paths)).toEqual({ toFile: null, local: false });
    expect(resolvePackageImport('C', 'example.com/proj::pkg', m2f, paths)).toEqual({ toFile: null, local: false }); // cgo
  });

  it('resolves nested go.mod sub-module imports from any importer (stress #9/#10)', () => {
    // terraform shape: internal/legacy has its OWN go.mod → its files' keys carry the full
    // module path as the first segment; a ROOT-module importer strips the root path only.
    const nested = new Map<string, string>([
      ['example.com/proj', 'main.go'],
      ['example.com/proj::cmd', 'cmd/cli.go'],
      ['example.com/proj/internal/legacy::terraform', 'internal/legacy/terraform/state.go'],
      ['example.com/proj/internal/backend/remote-state/aws', 'internal/backend/remote-state/aws/backend.go'],
    ]);
    const nestedPaths = modulePathsOf(nested);
    // root-module file importing a sub-module package
    expect(resolvePackageImport('example.com/proj/internal/legacy/terraform', 'example.com/proj::cmd', nested, nestedPaths)).toEqual({
      toFile: 'internal/legacy/terraform/state.go',
      local: true,
    });
    // root-module file importing a sub-module ROOT package (dir with go.mod = package too)
    expect(resolvePackageImport('example.com/proj/internal/backend/remote-state/aws', 'example.com/proj::cmd', nested, nestedPaths)).toEqual({
      toFile: 'internal/backend/remote-state/aws/backend.go',
      local: true,
    });
    // sub-module file importing another sub-module — still local, still resolves
    expect(resolvePackageImport('example.com/proj/internal/legacy/terraform', 'example.com/proj/internal/legacy::helper', nested, nestedPaths)).toEqual({
      toFile: 'internal/legacy/terraform/state.go',
      local: true,
    });
    // a local miss inside a sub-module namespace → unresolved (honest)
    expect(resolvePackageImport('example.com/proj/internal/legacy/missing', 'example.com/proj::cmd', nested, nestedPaths)).toEqual({
      toFile: null,
      local: true,
    });
  });

  it('resolves GOPATH-style and relative imports', () => {
    expect(resolvePackageImport('github.com/me/proj/pkg', 'github.com::me::proj::pkg', gopathM2f, gopathPaths)).toEqual({
      toFile: 'github.com/me/proj/pkg/x.go',
      local: true,
    });
    expect(resolvePackageImport('./foo', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: 'pkg/foo/bar.go', // ./foo from pkg/ → the pkg::foo package
      local: true,
    });
    expect(resolvePackageImport('../internal', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: 'internal/thing.go',
      local: true,
    });
    // escapes the root → no candidates, still local (broken — Go rejects it)
    expect(resolvePackageImport('../../../nope', 'example.com/proj', m2f, paths)).toEqual({ toFile: null, local: true });
  });

  it('no-module importer: a miss is external, not unresolved', () => {
    expect(resolvePackageImport('golang.org/x/sync', 'github.com::me::proj::pkg', gopathM2f, gopathPaths)).toEqual({
      toFile: null,
      local: false,
    });
    // a top-dir prefix match is local even when it misses (broken own import under github.com/)
    expect(resolvePackageImport('github.com/me/other', 'github.com::me::proj::pkg', gopathM2f, gopathPaths)).toEqual({
      toFile: null,
      local: true,
    });
  });
});

describe('go importer', () => {
  it('extracts single + grouped + aliased + blank + dot imports, resolves locals, skips externals', async () => {
    const files: SourceFile[] = [
      { path: 'main.go', content: 'package main\n\nimport (\n\t"fmt"\n\t_ "embed"\n\t"example.com/proj/pkg"\n)\n\nfunc main() { fmt.Println() }\n' },
      { path: 'pkg/foo.go', content: 'package pkg\n\nimport (\n\t"net/http"\n\tx "example.com/proj/pkg/foo"\n\t. "example.com/proj/internal"\n)\n' },
      { path: 'pkg/foo/bar.go', content: 'package foo\n\nfunc Bar() {}\n' },
      { path: 'internal/thing.go', content: 'package internal\n\nfunc Thing() {}\n' },
      { path: 'cmd/cli/main.go', content: 'package main\n\nimport "example.com/proj/pkg/nope"\n' },
    ];

    const { edges, unresolved } = await extractInModule('example.com/proj', files);
    // grouped import → spec_list → spec per line; fmt/embed external
    const pkg = edges.find((e) => e.import === 'example.com/proj/pkg');
    expect(pkg).toBeDefined();
    expect(pkg?.fromFile).toBe('main.go');
    expect(pkg?.toFile).toBe('pkg/foo.go');
    // aliased + dot imports still resolve (alias/dot don't change the dependency)
    expect(edges.find((e) => e.import === 'example.com/proj/pkg/foo')?.toFile).toBe('pkg/foo/bar.go');
    expect(edges.find((e) => e.import === 'example.com/proj/internal')?.toFile).toBe('internal/thing.go');
    // a genuinely missing local package → unresolved (honest)
    expect(unresolved.map((u) => u.import)).toContain('example.com/proj/pkg/nope');
    // externals never appear anywhere
    expect(edges.map((e) => e.import)).not.toContain('fmt');
    expect(unresolved.map((u) => u.import)).not.toContain('fmt');
  });

  it('tree-sitter-go parses import variants (grammar sanity)', async () => {
    const parser = await getGrammarParser('tree-sitter-go.wasm');
    const tree = parser.parse('package main\nimport "example.com/proj/a"\nimport (\n\t"example.com/proj/b"\n\talias "example.com/proj/c"\n\t_ "example.com/proj/d"\n\t. "example.com/proj/e"\n)\n');
    if (!tree) throw new Error('go grammar failed to parse the fixture');
    const content = tree.rootNode.text;
    tree.delete();
    const files: SourceFile[] = [{ path: 'main.go', content }, ...['a', 'b', 'c', 'd', 'e'].map((n) => ({ path: `${n}/${n}.go`, content: `package ${n}\n` }))];

    const { edges } = await extractInModule('example.com/proj', files);
    // single + grouped + aliased + blank + dot specs all extract; blank/dot still create the dep
    expect(edges.map((e) => e.import).sort()).toEqual(['example.com/proj/a', 'example.com/proj/b', 'example.com/proj/c', 'example.com/proj/d', 'example.com/proj/e']);
  });
});
