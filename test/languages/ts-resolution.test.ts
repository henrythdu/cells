import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOne, factsOf } from '../../src/languages/ts-resolution.js';
import type { ResolveCtx } from '../../src/languages/tree-sitter.js';

/**
 * Direct tests for the TS resolution core — no parser, no WASM: a specifier + a fixture
 * repo on disk + a ResolveCtx over its census. These are the resolution semantics the
 * oracle harness (scripts/validate-crossings) judges, tested at the decision point.
 */

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** Write a fixture repo; return a ResolveCtx over the given census files. */
function fixture(files: string[], extra?: Record<string, string>): { ctx: ResolveCtx; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ts-res-'));
  tmp = dir;
  const write = (rel: string, content: string): void => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  };
  for (const f of files) write(f, '');
  for (const [f, c] of Object.entries(extra ?? {})) write(f, c);
  const ctx: ResolveCtx = {
    files: new Set(files),
    moduleToFile: new Map(files.map((f) => [f, f])),
    crateNames: new Set(),
    reexports: new Map(),
    externalReexports: new Map(),
    baseDir: dir,
    codeDirs: ['.'],
    memo: new Map(),
  };
  return { ctx, dir };
}

const resolve = (spec: string, from: string, ctx: ResolveCtx) => resolveOne(spec, from, ctx, factsOf(ctx));

describe('relative specifiers', () => {
  it('extension probing: ./b lands on b.ts', () => {
    const { ctx } = fixture(['src/a.ts', 'src/b.ts']);
    expect(resolve('./b', 'src/a.ts', ctx)).toEqual({ toFile: 'src/b.ts', local: true });
  });

  it('NodeNext remap: ./b.js lands on the b.ts source', () => {
    const { ctx } = fixture(['src/a.ts', 'src/b.ts']);
    expect(resolve('./b.js', 'src/a.ts', ctx)).toEqual({ toFile: 'src/b.ts', local: true });
  });

  it('directory index: ./util lands on util/index.ts', () => {
    const { ctx } = fixture(['src/a.ts', 'src/util/index.ts']);
    expect(resolve('./util', 'src/a.ts', ctx)).toEqual({ toFile: 'src/util/index.ts', local: true });
  });

  it('dist→src remap: a dist-relative import lands on the source tree', () => {
    const { ctx } = fixture(['dist/a.ts', 'src/x.ts']);
    expect(resolve('./x', 'dist/a.ts', ctx)).toEqual({ toFile: 'src/x.ts', local: true });
  });

  it('a missing relative is a broken local (flagged), not silent', () => {
    const { ctx } = fixture(['src/a.ts']);
    expect(resolve('./gone', 'src/a.ts', ctx)).toEqual({ toFile: null, local: true });
  });

  it('vite query suffix strips for resolution: ./worker?worker lands on worker.ts', () => {
    const { ctx } = fixture(['src/a.ts', 'src/worker.ts']);
    expect(resolve('./worker?worker&url', 'src/a.ts', ctx)).toEqual({ toFile: 'src/worker.ts', local: true });
  });

  it('existing non-code target (json) resolves — the importer gates it on the census', () => {
    const { ctx } = fixture(['src/a.ts', 'src/data.json']);
    expect(resolve('./data.json', 'src/a.ts', ctx)).toEqual({ toFile: 'src/data.json', local: true });
  });
});

describe('tsconfig paths aliases', () => {
  it('wildcard alias: @/util via paths {"@/*": ["src/*"]}', () => {
    const { ctx } = fixture(['src/app.ts', 'src/util.ts'], { 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}' });
    expect(resolve('@/util', 'src/app.ts', ctx)).toEqual({ toFile: 'src/util.ts', local: true });
  });

  it('exact alias: @lib maps to one file', () => {
    const { ctx } = fixture(['src/app.ts', 'src/lib.ts'], { 'tsconfig.json': '{"compilerOptions":{"paths":{"@lib":["src/lib.ts"]}}}' });
    expect(resolve('@lib', 'src/app.ts', ctx)).toEqual({ toFile: 'src/lib.ts', local: true });
  });

  it('mapped-but-missing target is a broken local (flagged)', () => {
    const { ctx } = fixture(['src/app.ts'], { 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}' });
    expect(resolve('@/gone', 'src/app.ts', ctx)).toEqual({ toFile: null, local: true });
  });

  it('catch-all alias that misses falls through to external (never flags a package)', () => {
    const { ctx } = fixture(['src/app.ts'], { 'tsconfig.json': '{"compilerOptions":{"paths":{"@*":["src/*"]}}}' });
    expect(resolve('@icons-pack/x', 'src/app.ts', ctx)).toEqual({ toFile: null, local: false });
  });

  it('REG: same-dir extends (./tsconfig.base.json) resolves instead of recursing forever', () => {
    const { ctx } = fixture(['src/app.ts', 'src/util.ts'], {
      'tsconfig.json': '{"extends":"./tsconfig.base.json","compilerOptions":{"paths":{"@/*":["src/*"]}}}',
      'tsconfig.base.json': '{"compilerOptions":{"baseUrl":"."}}',
    });
    expect(resolve('@/util', 'src/app.ts', ctx)).toEqual({ toFile: 'src/util.ts', local: true });
  });

  it('parent-dir extends (../../tsconfig.json) carries the root aliases into a package', () => {
    const files = ['packages/a/src/app.ts', 'src/util.ts'];
    const { ctx } = fixture(files, {
      'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
      'packages/a/tsconfig.json': '{"extends":"../../tsconfig.json"}',
    });
    // inherited targets stay relative to the config that DECLARED them (the root) —
    // tsc semantics: @/* → repo-root src/*
    expect(resolve('@/util', 'packages/a/src/app.ts', ctx)).toEqual({ toFile: 'src/util.ts', local: true });
  });

  it('nearest config wins: a nested project shadows the root alias', () => {
    const files = ['packages/a/src/app.ts', 'packages/a/src/util.ts', 'src/root-util.ts'];
    const { ctx } = fixture(files, {
      'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
      'packages/a/tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
    });
    // root alias would land on src/util.ts (root-relative); the nested config's targets
    // are relative to ITS dir → packages/a/src/util.ts
    expect(resolve('@/util', 'packages/a/src/app.ts', ctx)).toEqual({ toFile: 'packages/a/src/util.ts', local: true });
  });

  it('jsonc tolerance: comments + trailing commas parse', () => {
    const { ctx } = fixture(['src/app.ts', 'src/util.ts'], { 'tsconfig.json': '{\n  // path aliases\n  "compilerOptions": {\n    "paths": {"@/*": ["src/*"],},},\n}' });
    expect(resolve('@/util', 'src/app.ts', ctx)).toEqual({ toFile: 'src/util.ts', local: true });
  });
});

describe('workspace package map', () => {
  const pkgJson = '{"name":"a","exports":{"./sub":"./src/sub.ts","./features/*":"./src/features/*.ts"}}';

  it('exports exact subpath: a/sub → packages/a/src/sub.ts', () => {
    const { ctx } = fixture(['packages/a/src/sub.ts', 'apps/web/src/index.ts'], {
      'package.json': '{"workspaces":["packages/*","apps/*"]}',
      'packages/a/package.json': pkgJson,
    });
    expect(resolve('a/sub', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: 'packages/a/src/sub.ts', local: true });
  });

  it('exports wildcard: a/features/x → packages/a/src/features/x.ts', () => {
    const { ctx } = fixture(['packages/a/src/features/x.ts', 'apps/web/src/index.ts'], {
      'package.json': '{"workspaces":["packages/*","apps/*"]}',
      'packages/a/package.json': pkgJson,
    });
    expect(resolve('a/features/x', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: 'packages/a/src/features/x.ts', local: true });
  });

  it('no exports: a/rest resolves <pkgdir>/rest (stress #16 heuristic)', () => {
    const { ctx } = fixture(['packages/a/rest.ts', 'apps/web/src/index.ts'], {
      'package.json': '{"workspaces":["packages/*","apps/*"]}',
      'packages/a/package.json': '{"name":"a"}',
    });
    expect(resolve('a/rest', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: 'packages/a/rest.ts', local: true });
  });

  it('dist entry remaps to source: a resolves via dist/index.js → src/index.ts', () => {
    const { ctx } = fixture(['packages/a/src/index.ts', 'apps/web/src/index.ts'], {
      'package.json': '{"workspaces":["packages/*","apps/*"]}',
      'packages/a/package.json': '{"name":"a","main":"dist/index.js"}',
    });
    expect(resolve('a', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: 'packages/a/src/index.ts', local: true });
  });

  it('known package, broken subpath → flagged local; unknown package → silent external', () => {
    const { ctx } = fixture(['packages/a/src/index.ts', 'apps/web/src/index.ts'], {
      'package.json': '{"workspaces":["packages/*","apps/*"]}',
      'packages/a/package.json': '{"name":"a"}',
    });
    expect(resolve('a/missing', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: null, local: true });
    expect(resolve('react', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: null, local: false });
    expect(resolve('node:fs', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: null, local: false });
  });

  it('non-workspace nested package.json is NOT a local package (no node_modules link)', () => {
    const { ctx } = fixture(['examples/standalone/src/index.ts', 'apps/web/src/index.ts'], {
      'package.json': '{"workspaces":["apps/*"]}',
      'examples/standalone/package.json': '{"name":"standalone"}',
    });
    expect(resolve('standalone', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: null, local: false });
  });

  it('REG: no workspace config at all — nested package.json still NOT local', () => {
    const { ctx } = fixture(['legacy/src/index.ts', 'src/app.ts'], {
      'package.json': '{"name":"root"}', // no workspaces field
      'legacy/package.json': '{"name":"legacy"}',
    });
    expect(resolve('legacy', 'src/app.ts', ctx)).toEqual({ toFile: null, local: false });
  });

  it('pnpm-workspace.yaml globs work as the workspace root', () => {
    const { ctx } = fixture(['packages/a/src/index.ts', 'apps/web/src/index.ts'], {
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - apps/*\n',
      'packages/a/package.json': '{"name":"a"}',
    });
    expect(resolve('a', 'apps/web/src/index.ts', ctx)).toEqual({ toFile: 'packages/a/src/index.ts', local: true });
  });
});

describe('external classification', () => {
  it('unmapped alias-style prefixes look local (broken config evidence)', () => {
    const { ctx } = fixture(['src/app.ts']);
    expect(resolve('@/x', 'src/app.ts', ctx)).toEqual({ toFile: null, local: true });
    expect(resolve('~/x', 'src/app.ts', ctx)).toEqual({ toFile: null, local: true });
    expect(resolve('#/x', 'src/app.ts', ctx)).toEqual({ toFile: null, local: true });
  });

  it('scoped external package with a slash stays silent', () => {
    const { ctx } = fixture(['src/app.ts']);
    expect(resolve('@scope/pkg/sub', 'src/app.ts', ctx)).toEqual({ toFile: null, local: false });
  });
});
