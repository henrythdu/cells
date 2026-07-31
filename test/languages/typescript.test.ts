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
});
