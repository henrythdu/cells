import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { depCruiserImporter } from '../../src/languages/typescript.js';

const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    baseUrl: '.',
    paths: { '@/*': ['src/*'] },
    strict: true,
  },
  include: ['src/**/*'],
});

const fixtures = new Set<string>();

function makeFixture(tsconfig: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'cells-ts-'));
  fixtures.add(dir);
  if (tsconfig) writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG_PATHS);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), "import { b } from '@/b';\nimport { x } from './missing';\nexport const a = b;\n");
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  return dir;
}

afterEach(() => {
  for (const d of fixtures) rmSync(d, { recursive: true, force: true });
  fixtures.clear();
});

describe('depCruiserImporter (tsconfig paths aliases)', () => {
  /** Real usage: cells runs with cwd = repo root, codeDirs relative. Mirror that. */
  async function extractAt(dir: string) {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return await depCruiserImporter.extract({ codeDirs: ['src'], files: [], ownership: {} });
    } finally {
      process.chdir(prev);
    }
  }

  it('resolves `@/` aliases when the repo tsconfig is present (edge to the real file)', async () => {
    const dir = makeFixture(true);
    const { edges, unresolved } = await extractAt(dir);
    const alias = edges.find((e) => e.import === '@/b');
    expect(alias).toBeDefined();
    expect(alias!.toFile).toContain('src/b.ts'); // the alias target, not left dangling
    expect(unresolved.some((u) => u.import === '@/b')).toBe(false); // resolved, not flagged
    expect(unresolved.some((u) => u.import === './missing')).toBe(true); // real broken import still flagged
  });

  it('flags failed `@/` specifiers as local-unresolved when tsconfig is missing (no silent drop)', async () => {
    const dir = makeFixture(false);
    const { edges, unresolved } = await extractAt(dir);
    expect(edges.some((e) => e.import === '@/b')).toBe(false); // no tsconfig → cannot resolve
    expect(unresolved.some((u) => u.import === '@/b')).toBe(true); // …but surfaced, not swallowed
  });

  it('reads `paths` from a jsonc tsconfig (trailing comma — bug #11: turborepo apps/web)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-tsc-jsonc-'));
    fixtures.add(dir);
    // jsonc: trailing comma after the last `paths` entry — legal TS, invalid strict JSON
    writeFileSync(
      join(dir, 'tsconfig.json'),
      `{
  "compilerOptions": {
    "paths": {
      "@/*": ["src/*"],
      "~/*": ["server/*"],
    },
  },
}`,
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), "import { b } from '@/b';\nimport { s } from '~/s';\n");
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(dir, 'server', 's.ts'), 'export const s = 1;\n');
    const { edges, unresolved } = await extractAt(dir);
    expect(edges.some((e) => e.import === '@/b')).toBe(true); // aliases resolve despite the trailing comma
    expect(edges.some((e) => e.import === '~/s')).toBe(true);
    expect(unresolved.some((u) => u.import === '@/b' || u.import === '~/s')).toBe(false);
  });

  it('resolves workspace package-name imports to the package entry source (monorepo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ws-ts-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'packages', 'utils', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'utils', 'src', 'dir'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'create-turbo', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'legacy', 'src'), { recursive: true });
    // dist-only main → must land on src/index.ts; exports subpath key → dir/index.default.js
    writeFileSync(join(dir, 'packages', 'utils', 'package.json'), JSON.stringify({ name: '@turbo/utils', main: './dist/index.js', exports: { '.': './dist/index.js', './with-module': './src/dir/index.default.js' } }));
    writeFileSync(join(dir, 'packages', 'create-turbo', 'package.json'), JSON.stringify({ name: '@turbo/create-turbo' }));
    writeFileSync(join(dir, 'packages', 'legacy', 'package.json'), JSON.stringify({ name: '@vitejs/plugin-legacy' }));
    writeFileSync(join(dir, 'packages', 'utils', 'src', 'index.ts'), 'export const foo = 1;\n');
    writeFileSync(join(dir, 'packages', 'utils', 'src', 'deep.ts'), 'export const bar = 2;\n');
    writeFileSync(join(dir, 'packages', 'utils', 'src', 'dir', 'index.default.js'), 'export const baz = 3;\n');
    writeFileSync(
      join(dir, 'packages', 'create-turbo', 'src', 'cli.ts'),
      "import { foo } from '@turbo/utils';\nimport { bar } from '@turbo/utils/deep';\nimport { baz } from '@turbo/utils/with-module';\nimport { nope } from '@turbo/nope';\nexport const a = foo;\n",
    );

    const prev = process.cwd();
    process.chdir(dir);
    try {
      const { edges, unresolved } = await depCruiserImporter.extract({
        codeDirs: ['packages'],
        files: [
          { path: 'packages/create-turbo/src/cli.ts', content: '' },
          { path: 'packages/utils/src/index.ts', content: '' },
          { path: 'packages/utils/src/deep.ts', content: '' },
          { path: 'packages/utils/src/dir/index.default.js', content: '' },
        ],
        ownership: {},
      });
      const exact = edges.find((e) => e.import === '@turbo/utils');
      expect(exact).toBeDefined();
      expect(exact!.toFile).toContain('packages/utils/src/index.ts'); // dist-only main → source via probes
      const sub = edges.find((e) => e.import === '@turbo/utils/deep');
      expect(sub).toBeDefined();
      expect(sub!.toFile).toContain('packages/utils/src/deep.ts'); // heuristic: entry dir + rest
      const mod = edges.find((e) => e.import === '@turbo/utils/with-module');
      expect(mod).toBeDefined();
      expect(mod!.toFile).toContain('packages/utils/src/dir/index.default.js'); // exports subpath key
      expect(edges.some((e) => e.import === '@turbo/nope')).toBe(false); // unknown name → external, silent
      expect(unresolved.some((u) => u.import === '@turbo/nope')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  it('resolves a no-exports workspace subpath the Node way — pkgdir + rest (stress #16: @turbo/utils/src/get-turbo-configs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ws-subpath-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'packages', 'turbo-utils', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'eslint-plugin-turbo', 'lib', 'utils'), { recursive: true });
    // NO exports field — the old entry-dir probe looked in src/src/ and flagged this
    // resolvable import as unresolved (the stress agent's #16)
    writeFileSync(join(dir, 'packages', 'turbo-utils', 'package.json'), JSON.stringify({ name: '@turbo/utils', main: 'src/index.ts' }));
    writeFileSync(join(dir, 'packages', 'turbo-utils', 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'packages', 'turbo-utils', 'src', 'get-turbo-configs.ts'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'packages', 'eslint-plugin-turbo', 'lib', 'utils', 'calculate-inputs.ts'), "import { b } from '@turbo/utils/src/get-turbo-configs';\nexport const c = b;\n");

    const prev = process.cwd();
    process.chdir(dir);
    try {
      const { edges, unresolved } = await depCruiserImporter.extract({
        codeDirs: ['packages'],
        files: [
          { path: 'packages/eslint-plugin-turbo/lib/utils/calculate-inputs.ts', content: '' },
          { path: 'packages/turbo-utils/src/index.ts', content: '' },
          { path: 'packages/turbo-utils/src/get-turbo-configs.ts', content: '' },
        ],
        ownership: {},
      });
      const hit = edges.find((e) => e.import === '@turbo/utils/src/get-turbo-configs');
      expect(hit).toBeDefined();
      expect(hit!.toFile).toContain('packages/turbo-utils/src/get-turbo-configs.ts');
      expect(unresolved.some((u) => u.import === '@turbo/utils/src/get-turbo-configs')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  it('resolves a subpath whose exports target is dist-flattened (vite: ./module-runner → dist/node/x.js, source src/module-runner/)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-flat-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'packages', 'vite', 'src', 'module-runner'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    // dist target not committed (real repos); entry resolves to source, and the entry-dir +
    // rest heuristic finds the flattened source — the rollup-flatten guess is NOT needed
    writeFileSync(join(dir, 'packages', 'vite', 'package.json'), JSON.stringify({ name: '@vitejs/test', main: './dist/index.js', exports: { '.': './dist/index.js', './module-runner': './dist/node/module-runner.js' } }));
    writeFileSync(join(dir, 'packages', 'vite', 'src', 'index.ts'), 'export const vite = 1;\n');
    writeFileSync(join(dir, 'packages', 'vite', 'src', 'module-runner', 'index.ts'), 'export const mr = 1;\n');
    writeFileSync(join(dir, 'apps', 'web', 'main.ts'), "import { mr } from '@vitejs/test/module-runner';\n");

    const prev = process.cwd();
    process.chdir(dir);
    try {
      const { edges, unresolved } = await depCruiserImporter.extract({
        codeDirs: ['.'],
        files: [
          { path: 'apps/web/main.ts', content: '' },
          { path: 'packages/vite/src/index.ts', content: '' },
          { path: 'packages/vite/src/module-runner/index.ts', content: '' },
        ],
        ownership: {},
      });
      const sub = edges.find((e) => e.import === '@vitejs/test/module-runner');
      expect(sub).toBeDefined();
      expect(sub!.toFile).toContain('packages/vite/src/module-runner/index.ts');
      expect(unresolved.some((u) => u.import === '@vitejs/test/module-runner')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  it('merges nested per-app tsconfig paths so @/ aliases resolve (wave-3 #3: turborepo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-merge-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'apps', 'docs', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'docs', 'app'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }));
    writeFileSync(join(dir, 'apps', 'docs', 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
    writeFileSync(join(dir, 'apps', 'docs', 'lib', 'create-metadata.ts'), 'export const m = 1;\n');
    writeFileSync(join(dir, 'apps', 'docs', 'app', 'page.tsx'), "import { m } from '@/lib/create-metadata';\nexport const p = m;\n");

    const prev = process.cwd();
    process.chdir(dir);
    try {
      const { edges, unresolved } = await depCruiserImporter.extract({
        codeDirs: ['.'],
        files: [
          { path: 'apps/docs/app/page.tsx', content: '' },
          { path: 'apps/docs/lib/create-metadata.ts', content: '' },
        ],
        ownership: {},
      });
      const viaAlias = edges.find((e) => e.import === '@/lib/create-metadata');
      expect(viaAlias).toBeDefined();
      expect(viaAlias!.toFile).toContain('apps/docs/lib/create-metadata.ts');
      expect(unresolved.some((u) => u.import === '@/lib/create-metadata')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  it('resolves directory + dist-artifact relative imports (stress #6/#8: require(..), dist→src)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-rel-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'lib', 'util', 'test'), { recursive: true });
    mkdirSync(join(dir, 'lib', 'util'), { recursive: true });
    mkdirSync(join(dir, 'pkg', 'dist', 'node'), { recursive: true });
    mkdirSync(join(dir, 'pkg', 'src', 'node'), { recursive: true });
    // directory import with an index file: require('..') → the dir's index.js
    writeFileSync(join(dir, 'lib', 'util', 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(dir, 'lib', 'util', 'test', 'arrays.js'), 'const _ = require("..");\n');
    // source importing its own dist artifact (dist/ not committed — like real repos): the
    // probe's dist→src variants land on the source file
    writeFileSync(join(dir, 'pkg', 'src', 'node', 'cli.ts'), 'export const cli = 1;\n');
    writeFileSync(join(dir, 'pkg', 'index.js'), 'require("./dist/node/cli");\n');

    const prev = process.cwd();
    process.chdir(dir);
    try {
      const { edges, unresolved } = await depCruiserImporter.extract({
        codeDirs: ['.'],
        files: [
          { path: 'lib/util/test/arrays.js', content: '' },
          { path: 'lib/util/index.js', content: '' },
          { path: 'pkg/index.js', content: '' },
          { path: 'pkg/src/node/cli.ts', content: '' },
        ],
        ownership: {},
      });
      const dirImport = edges.find((e) => e.import === '..');
      expect(dirImport).toBeDefined();
      expect(dirImport!.toFile).toContain('lib/util/index.js'); // require('..') → dir index
      const distImport = edges.find((e) => e.import === './dist/node/cli');
      expect(distImport).toBeDefined();
      expect(distImport!.toFile).toContain('pkg/src/node/cli.ts'); // dist artifact → source
      expect(unresolved.some((u) => u.import === '..')).toBe(false);
      expect(unresolved.some((u) => u.import === './dist/node/cli')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });
});
