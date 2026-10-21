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

/** Create a temporary directory that holds a `go.mod`. The importer probes the file system for
 *  the module root, the same way as the `Cargo.toml` walk of rust, so an extract-level test
 *  needs a real file on disk. */
function makeGoModule(modulePath: string): string {
  const dir = join(tmpdir(), `cells-go-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'go.mod'), `module ${modulePath}\n`);
  tmpDirs.push(dir);
  return dir;
}

/** Run the importer with the working directory inside a temporary directory that holds a `go.mod`. */
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
    expect(fileToModule('pkg/foo/z_test.go', undefined, repo)).toBe('example.com/proj::pkg::foo'); // The same package.
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
  // A repository with a module: the first segment of every key is the module path of `go.mod`.
  const m2f = new Map<string, string>([
    ['example.com/proj', 'main.go'],
    ['example.com/proj::pkg', 'pkg/foo.go'],
    ['example.com/proj::pkg::foo', 'pkg/foo/bar.go'],
    ['example.com/proj::internal', 'internal/thing.go'],
  ]);
  const paths = modulePathsOf(m2f);
  // A repository with no module (the GOPATH layout): the first segments are top-level directories.
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
      local: true, // An import of the root package of the module from inside it.
    });
  });

  it('flags local misses as unresolved, silently skips externals', () => {
    expect(resolvePackageImport('example.com/proj/pkg/missing', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: null,
      local: true, // A module-prefixed path is a broken local import, which the LLM must read.
    });
    expect(resolvePackageImport('fmt', 'example.com/proj::pkg', m2f, paths)).toEqual({ toFile: null, local: false });
    expect(resolvePackageImport('github.com/other/x', 'example.com/proj::pkg', m2f, paths)).toEqual({ toFile: null, local: false });
    expect(resolvePackageImport('C', 'example.com/proj::pkg', m2f, paths)).toEqual({ toFile: null, local: false }); // A cgo import.
  });

  it('resolves nested go.mod sub-module imports from any importer', () => {
    // The shape of terraform: `internal/legacy` has its OWN `go.mod`, so the keys of its files
    // carry the full module path as the first segment. An importer of the ROOT module strips only
    // the root path.
    const nested = new Map<string, string>([
      ['example.com/proj', 'main.go'],
      ['example.com/proj::cmd', 'cmd/cli.go'],
      ['example.com/proj/internal/legacy::terraform', 'internal/legacy/terraform/state.go'],
      ['example.com/proj/internal/backend/remote-state/aws', 'internal/backend/remote-state/aws/backend.go'],
    ]);
    const nestedPaths = modulePathsOf(nested);
    // A file of the root module that imports a package of a sub-module.
    expect(resolvePackageImport('example.com/proj/internal/legacy/terraform', 'example.com/proj::cmd', nested, nestedPaths)).toEqual({
      toFile: 'internal/legacy/terraform/state.go',
      local: true,
    });
    // A file of the root module that imports the ROOT package of a sub-module (a directory with a `go.mod` is a package too).
    expect(resolvePackageImport('example.com/proj/internal/backend/remote-state/aws', 'example.com/proj::cmd', nested, nestedPaths)).toEqual({
      toFile: 'internal/backend/remote-state/aws/backend.go',
      local: true,
    });
    // A file of a sub-module that imports another sub-module. The import is still local and still resolves.
    expect(resolvePackageImport('example.com/proj/internal/legacy/terraform', 'example.com/proj/internal/legacy::helper', nested, nestedPaths)).toEqual({
      toFile: 'internal/legacy/terraform/state.go',
      local: true,
    });
    // A local miss inside the namespace of a sub-module gives an unresolved import, which is honest.
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
      toFile: 'pkg/foo/bar.go', // `./foo` from `pkg/` gives the `pkg::foo` package.
      local: true,
    });
    expect(resolvePackageImport('../internal', 'example.com/proj::pkg', m2f, paths)).toEqual({
      toFile: 'internal/thing.go',
      local: true,
    });
    // The path escapes the root, so it has no candidates and stays local. The import is broken, and Go rejects it.
    expect(resolvePackageImport('../../../nope', 'example.com/proj', m2f, paths)).toEqual({ toFile: null, local: true });
  });

  it('no-module importer: a miss is external, not unresolved', () => {
    expect(resolvePackageImport('golang.org/x/sync', 'github.com::me::proj::pkg', gopathM2f, gopathPaths)).toEqual({
      toFile: null,
      local: false,
    });
    // A prefix match on a top-level directory is local even when it misses, so a broken own import under `github.com/` still flags.
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
    // A grouped import goes from spec_list to one spec per line. The `fmt` and `embed` packages are external.
    const pkg = edges.find((e) => e.import === 'example.com/proj/pkg');
    expect(pkg).toBeDefined();
    expect(pkg?.fromFile).toBe('main.go');
    expect(pkg?.toFile).toBe('pkg/foo.go');
    // An aliased import and a dot import still resolve, because the alias and the dot do not change the dependency.
    expect(edges.find((e) => e.import === 'example.com/proj/pkg/foo')?.toFile).toBe('pkg/foo/bar.go');
    expect(edges.find((e) => e.import === 'example.com/proj/internal')?.toFile).toBe('internal/thing.go');
    // A local package that is genuinely missing gives an unresolved import, which is honest.
    expect(unresolved.map((u) => u.import)).toContain('example.com/proj/pkg/nope');
    // An external import never appears anywhere.
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
    // A single spec, a grouped spec, an aliased spec, a blank spec, and a dot spec all extract. A blank or dot spec still creates the dependency.
    expect(edges.map((e) => e.import).sort()).toEqual(['example.com/proj/a', 'example.com/proj/b', 'example.com/proj/c', 'example.com/proj/d', 'example.com/proj/e']);
  });

  it('extracts a raw-string import (backticks), not only a quoted one', async () => {
    const files: SourceFile[] = [
      { path: 'pkg/a/a.go', content: 'package a\n\nimport `example.com/proj/pkg/b`\n\nvar _ = b.X\n' },
      { path: 'pkg/b/b.go', content: 'package b\n\nconst X = 1\n' },
    ];
    const { edges, unresolved } = await extractInModule('example.com/proj', files);
    // `pkg/b` exists, so the dependency must be a real edge and not a diagnostic.
    expect(edges.find((e) => e.import === 'example.com/proj/pkg/b')?.toFile).toBe('pkg/b/b.go');
    expect(unresolved).toEqual([]);
  });
});
