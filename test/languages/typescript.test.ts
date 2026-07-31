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
});
