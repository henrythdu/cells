import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { typescriptImporter, javascriptImporter, tsxImporter } from '../../src/languages/typescript.js';
import type { SourceFile } from '../../src/imports.js';

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

/** Extract with the census files read from the fixture (tree-sitter importers parse `files`,
 *  unlike dep-cruiser which cruised the FS). */
async function extractAt(dir: string, importer = typescriptImporter, files?: SourceFile[]) {
  const known: SourceFile[] =
    files ??
    (await (async () => {
      const src = ['a.ts', 'b.ts'];
      const out: SourceFile[] = [];
      for (const f of src) {
        const p = `src/${f}`;
        out.push({ path: p, content: require('node:fs').readFileSync(join(dir, p), 'utf8') });
      }
      return out;
    })());
  return importer.extract({ codeDirs: ['src'], files: known, baseDir: dir });
}

describe('typescriptImporter (tree-sitter)', () => {
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
    const { edges, unresolved } = await extractAt(dir, typescriptImporter, [
      { path: 'src/a.ts', content: "import { b } from '@/b';\nimport { s } from '~/s';\n" },
      { path: 'src/b.ts', content: 'export const b = 1;\n' },
      { path: 'server/s.ts', content: 'export const s = 1;\n' },
    ]);
    expect(edges.some((e) => e.import === '@/b')).toBe(true); // aliases resolve despite the trailing comma
    expect(edges.some((e) => e.import === '~/s')).toBe(true);
    expect(unresolved.some((u) => u.import === '@/b' || u.import === '~/s')).toBe(false);
  });

  it('resolves workspace package-name imports to the package entry source (monorepo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ws-ts-'));
    fixtures.add(dir);
    // the workspace root: nested packages are local ONLY when the root declares them
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
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
    const { edges, unresolved } = await typescriptImporter.extract({
      codeDirs: ['packages'],
      files: [
        {
          path: 'packages/create-turbo/src/cli.ts',
          content: "import { foo } from '@turbo/utils';\nimport { bar } from '@turbo/utils/deep';\nimport { baz } from '@turbo/utils/with-module';\nimport { nope } from '@turbo/nope';\nexport const a = foo;\n",
        },
        { path: 'packages/utils/src/index.ts', content: '' },
        { path: 'packages/utils/src/deep.ts', content: '' },
        { path: 'packages/utils/src/dir/index.default.js', content: '' },
      ],
      baseDir: dir,
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
  });

  it('resolves a no-exports workspace subpath the Node way — pkgdir + rest (stress #16: @turbo/utils/src/get-turbo-configs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ws-subpath-'));
    fixtures.add(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(join(dir, 'packages', 'turbo-utils', 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'eslint-plugin-turbo', 'lib', 'utils'), { recursive: true });
    // NO exports field — the old entry-dir probe looked in src/src/ and flagged this
    // resolvable import as unresolved (the stress agent's #16)
    writeFileSync(join(dir, 'packages', 'turbo-utils', 'package.json'), JSON.stringify({ name: '@turbo/utils', main: 'src/index.ts' }));
    writeFileSync(join(dir, 'packages', 'turbo-utils', 'src', 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'packages', 'turbo-utils', 'src', 'get-turbo-configs.ts'), 'export const b = 2;\n');
    writeFileSync(join(dir, 'packages', 'eslint-plugin-turbo', 'lib', 'utils', 'calculate-inputs.ts'), "import { b } from '@turbo/utils/src/get-turbo-configs';\nexport const c = b;\n");
    const { edges, unresolved } = await typescriptImporter.extract({
      codeDirs: ['packages'],
      files: [
        { path: 'packages/eslint-plugin-turbo/lib/utils/calculate-inputs.ts', content: "import { b } from '@turbo/utils/src/get-turbo-configs';\nexport const c = b;\n" },
        { path: 'packages/turbo-utils/src/index.ts', content: '' },
        { path: 'packages/turbo-utils/src/get-turbo-configs.ts', content: '' },
      ],
      baseDir: dir,
    });
    const hit = edges.find((e) => e.import === '@turbo/utils/src/get-turbo-configs');
    expect(hit).toBeDefined();
    expect(hit!.toFile).toContain('packages/turbo-utils/src/get-turbo-configs.ts');
    expect(unresolved.some((u) => u.import === '@turbo/utils/src/get-turbo-configs')).toBe(false);
  });

  it('resolves a subpath whose exports target is dist-flattened (vite: ./module-runner → dist/node/x.js, source src/module-runner/)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-flat-'));
    fixtures.add(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    mkdirSync(join(dir, 'packages', 'vite', 'src', 'module-runner'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    // dist target not committed (real repos); entry resolves to source, and the entry-dir +
    // rest heuristic finds the flattened source — the rollup-flatten guess is NOT needed
    writeFileSync(join(dir, 'packages', 'vite', 'package.json'), JSON.stringify({ name: '@vitejs/test', main: './dist/index.js', exports: { '.': './dist/index.js', './module-runner': './dist/node/module-runner.js' } }));
    writeFileSync(join(dir, 'packages', 'vite', 'src', 'index.ts'), 'export const vite = 1;\n');
    writeFileSync(join(dir, 'packages', 'vite', 'src', 'module-runner', 'index.ts'), 'export const mr = 1;\n');
    writeFileSync(join(dir, 'apps', 'web', 'main.ts'), "import { mr } from '@vitejs/test/module-runner';\n");
    const { edges, unresolved } = await typescriptImporter.extract({
      codeDirs: ['.'],
      files: [
        { path: 'apps/web/main.ts', content: "import { mr } from '@vitejs/test/module-runner';\n" },
        { path: 'packages/vite/src/index.ts', content: '' },
        { path: 'packages/vite/src/module-runner/index.ts', content: '' },
      ],
      baseDir: dir,
    });
    const sub = edges.find((e) => e.import === '@vitejs/test/module-runner');
    expect(sub).toBeDefined();
    expect(sub!.toFile).toContain('packages/vite/src/module-runner/index.ts');
    expect(unresolved.some((u) => u.import === '@vitejs/test/module-runner')).toBe(false);
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
    const { edges, unresolved } = await tsxImporter.extract({
      codeDirs: ['.'],
      files: [
        { path: 'apps/docs/app/page.tsx', content: "import { m } from '@/lib/create-metadata';\nexport const p = m;\n" },
        { path: 'apps/docs/lib/create-metadata.ts', content: '' },
      ],
      baseDir: dir,
    });
    const viaAlias = edges.find((e) => e.import === '@/lib/create-metadata');
    expect(viaAlias).toBeDefined();
    expect(viaAlias!.toFile).toContain('apps/docs/lib/create-metadata.ts');
    expect(unresolved.some((u) => u.import === '@/lib/create-metadata')).toBe(false);
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
    const { edges, unresolved } = await javascriptImporter.extract({
      codeDirs: ['.'],
      files: [
        { path: 'lib/util/test/arrays.js', content: 'const _ = require("..");\n' },
        { path: 'lib/util/index.js', content: 'module.exports = {};\n' },
        { path: 'pkg/index.js', content: 'require("./dist/node/cli");\n' },
        { path: 'pkg/src/node/cli.ts', content: '' },
      ],
      baseDir: dir,
    });
    const dirImport = edges.find((e) => e.import === '..');
    expect(dirImport).toBeDefined();
    expect(dirImport!.toFile).toContain('lib/util/index.js'); // require('..') → dir index
    const distImport = edges.find((e) => e.import === './dist/node/cli');
    expect(distImport).toBeDefined();
    expect(distImport!.toFile).toContain('pkg/src/node/cli.ts'); // dist artifact → source
    expect(unresolved.some((u) => u.import === '..')).toBe(false);
    expect(unresolved.some((u) => u.import === './dist/node/cli')).toBe(false);
  });

  it('extracts ESM, CJS, dynamic import, import-equals and triple-slash reference (all TS import forms)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-forms-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), "import { b } from './b';\nimport './side.css';\nexport * from './reex';\nimport('dynamic/m').then(() => {});\nconst c = require('./cjs');\nimport z = require('./eq');\n");
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(dir, 'src', 'reex.ts'), 'export const r = 1;\n');
    writeFileSync(join(dir, 'src', 'cjs.js'), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'src', 'eq.ts'), 'export const e = 1;\n');
    writeFileSync(join(dir, 'src', 'side.css'), 'body { color: red; }\n');
    const { edges, unresolved } = await typescriptImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/a.ts', content: "import { b } from './b';\nimport './side.css';\nexport * from './reex';\nimport('dynamic/m').then(() => {});\nconst c = require('./cjs');\nimport z = require('./eq');\n" },
        { path: 'src/b.ts', content: 'export const b = 1;\n' },
        { path: 'src/reex.ts', content: 'export const r = 1;\n' },
        { path: 'src/cjs.js', content: 'module.exports = 1;\n' },
        { path: 'src/eq.ts', content: 'export const e = 1;\n' },
      ],
      baseDir: dir,
    });
    expect(edges.some((e) => e.import === './b')).toBe(true); // named import
    expect(edges.some((e) => e.import === './reex')).toBe(true); // export * from
    expect(edges.some((e) => e.import === './cjs')).toBe(true); // require()
    expect(edges.some((e) => e.import === './eq')).toBe(true); // import x = require()
    expect(edges.some((e) => e.import === 'dynamic/m')).toBe(false); // dynamic → external, silent
    expect(unresolved.some((u) => u.import === 'dynamic/m')).toBe(false);
    expect(unresolved.some((u) => u.import === './side.css')).toBe(false); // existing non-code → silent, NOT flagged
    expect(edges.some((e) => e.import === './side.css')).toBe(false); // …and not in the census → no edge
  });

  it('flags a broken relative import but stays silent on node builtins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-builtin-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), "import fs from 'node:fs';\nimport path from 'path';\nimport { x } from './nope';\n");
    const { edges, unresolved } = await typescriptImporter.extract({
      codeDirs: ['src'],
      files: [{ path: 'src/a.ts', content: "import fs from 'node:fs';\nimport path from 'path';\nimport { x } from './nope';\n" }],
      baseDir: dir,
    });
    expect(edges.length).toBe(0);
    expect(unresolved.some((u) => u.import === 'node:fs')).toBe(false); // builtins silent
    expect(unresolved.some((u) => u.import === 'path')).toBe(false);
    expect(unresolved.some((u) => u.import === './nope')).toBe(true); // broken relative flagged
  });

  it('drops self-imports and dedupes repeated specifiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cells-ts-self-'));
    fixtures.add(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), "import './b';\nimport './b';\nimport './a';\n");
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    const { edges } = await typescriptImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/a.ts', content: "import './b';\nimport './b';\nimport './a';\n" },
        { path: 'src/b.ts', content: '' },
      ],
      baseDir: dir,
    });
    expect(edges.filter((e) => e.import === './b').length).toBe(1); // deduped
    expect(edges.some((e) => e.import === './a')).toBe(false); // self-loop dropped
  });
});
