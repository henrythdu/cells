import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pythonImporter, fileToModule } from '../../src/languages/python.js';
import type { SourceFile } from '../../src/imports.js';
import type { Ownership } from '../../src/ownership.js';

const files: SourceFile[] = [
  { path: 'src/domain/symbol.py', content: 'class Symbol: pass\n' },
  { path: 'src/domain/graph.py', content: 'from src.domain.symbol import Symbol\n' },
  { path: 'src/stages/build.py', content: 'from src.domain.symbol import Symbol\nimport src.domain.graph\n' },
  { path: 'src/stages/rel.py', content: 'from . import sibling\nfrom ..domain.symbol import Sym\n' },
  { path: 'src/stages/sibling.py', content: 'x = 1\n' },
  { path: 'src/stages/ext.py', content: 'import numpy\nfrom os import path\n' },
];
const ownership: Ownership = {
  domain: ['src/domain/symbol.py', 'src/domain/graph.py'],
  stages: ['src/stages/build.py', 'src/stages/rel.py', 'src/stages/sibling.py', 'src/stages/ext.py'],
};

describe('python importer', () => {
  it('extracts absolute + relative edges, drops external', async () => {
    const { edges } = await pythonImporter.extract({ codeDirs: ['src'], files, ownership });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile} | ${e.import}`));
    expect(set).toEqual(
      new Set([
        'src/domain/graph.py -> src/domain/symbol.py | src.domain.symbol', // internal domain
        'src/stages/build.py -> src/domain/symbol.py | src.domain.symbol', // cross stages→domain (absolute)
        'src/stages/build.py -> src/domain/graph.py | src.domain.graph', // cross stages→domain (import M)
        'src/stages/rel.py -> src/stages/sibling.py | src.stages.sibling', // internal stages (from . import)
        'src/stages/rel.py -> src/domain/symbol.py | src.domain.symbol', // cross stages→domain (from ..M)
      ]),
    );
  });

  it('handles `import a, b.c` (multiple modules) and `as` aliases', async () => {
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
      ownership: { a: ['src/a.py'], b: ['src/b/c.py', 'src/b/d.py'] },
      files: [
        { path: 'src/a.py', content: 'import src.b.c, src.b.d as dee\n' },
        { path: 'src/b/c.py', content: 'x=1\n' },
        { path: 'src/b/d.py', content: 'x=1\n' },
      ],
    });
    const set = new Set(edges.map((e) => `${e.toFile}`));
    expect(set).toEqual(new Set(['src/b/c.py', 'src/b/d.py']));
  });

  it('finds imports inside function bodies (not just top-level)', async () => {
    const pySrc = ['def cmd():', '    from src.stages.predict import main', '    from src.stages.enrich import main as _main', ''].join('\n');
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
      ownership: { app: ['app/cli.py'], stages: ['src/stages/predict.py', 'src/stages/enrich.py'] },
      files: [
        { path: 'app/cli.py', content: pySrc },
        { path: 'src/stages/predict.py', content: 'def main(): pass\n' },
        { path: 'src/stages/enrich.py', content: 'def main(): pass\n' },
      ],
    });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toEqual(new Set(['app/cli.py -> src/stages/predict.py', 'app/cli.py -> src/stages/enrich.py']));
  });

  it('silences imports backed by compiled extension modules on disk (wave-3 #5: pyo3 _core.so)', async () => {
    const prev = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), 'cells-pycore-'));
    mkdirSync(join(repo, 'headroom'), { recursive: true });
    mkdirSync(join(repo, 'headroom', 'transforms'), { recursive: true });
    writeFileSync(join(repo, 'headroom', '__init__.py'), '\n');
    writeFileSync(join(repo, 'headroom', 'transforms', '__init__.py'), '\n');
    writeFileSync(join(repo, 'headroom', '_core.cpython-312-x86_64-linux-gnu.so'), 'binary\n');
    writeFileSync(join(repo, 'headroom', 'transforms', 'smart_crusher.py'), 'from headroom._core import X\nfrom headroom.transforms import Y\n');
    process.chdir(repo);
    try {
      const { edges: _edges, unresolved } = await pythonImporter.extract({
        codeDirs: ['.'],
        files: [
          { path: 'headroom/__init__.py', content: '\n' },
          { path: 'headroom/transforms/__init__.py', content: '\n' },
          { path: 'headroom/transforms/smart_crusher.py', content: 'from headroom._core import X\nfrom headroom.transforms import Y\n' },
        ],
        ownership: { headroom: ['headroom/__init__.py', 'headroom/transforms/__init__.py', 'headroom/transforms/smart_crusher.py'] },
      });
      expect(unresolved.some((u) => u.import === 'headroom._core')).toBe(false); // .so on disk → silent
      expect(unresolved.some((u) => u.import === 'headroom.transforms')).toBe(false); // resolves normally
    } finally {
      process.chdir(prev);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('fileToModule with module-root', () => {
  it('strips module-root prefix (src-layout)', () => {
    expect(fileToModule('src/domain/symbol.py', 'src')).toBe('domain.symbol');
  });

  it('without module-root, includes full path', () => {
    expect(fileToModule('src/domain/symbol.py')).toBe('src.domain.symbol');
  });

  it('handles __init__.py with module-root', () => {
    expect(fileToModule('src/domain/__init__.py', 'src')).toBe('domain');
  });

  it('module-root that does not match the path is ignored', () => {
    expect(fileToModule('lib/foo.py', 'src')).toBe('lib.foo');
  });
});

describe('module-root in importer (src-layout)', () => {
  it('resolves src-layout imports with module-root = "src"', async () => {
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
      moduleRoot: 'src',
      ownership: { domain: ['src/domain/symbol.py'], app: ['src/app/main.py'] },
      files: [
        { path: 'src/domain/symbol.py', content: 'class X: pass\n' },
        { path: 'src/app/main.py', content: 'from domain.symbol import X\n' },
      ],
    });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toContain('src/app/main.py -> src/domain/symbol.py');
  });

  it('WITHOUT module-root, src-layout import does not resolve', async () => {
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
      ownership: { domain: ['src/domain/symbol.py'], app: ['src/app/main.py'] },
      files: [
        { path: 'src/domain/symbol.py', content: 'class X: pass\n' },
        { path: 'src/app/main.py', content: 'from domain.symbol import X\n' },
      ],
    });
    expect(edges).toEqual([]); // without module-root, module is src.domain.symbol, not domain.symbol
  });
});

describe('unresolved local imports', () => {
  it('surfaces local imports that do not resolve to any file', async () => {
    const { unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      moduleRoot: 'src',
      ownership: { domain: ['src/domain/symbol.py'] },
      files: [{ path: 'src/domain/symbol.py', content: 'from domain.missing import X\n' }],
    });
    expect(unresolved.map((u) => u.import)).toContain('domain.missing');
  });

  it('external packages do not appear in unresolved', async () => {
    const { unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      ownership: { app: ['src/app.py'] },
      files: [{ path: 'src/app.py', content: 'import numpy\nfrom openai import X\n' }],
    });
    expect(unresolved).toEqual([]);
  });

  it('relative imports that do not resolve are flagged', async () => {
    const { unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      ownership: { app: ['src/app/main.py'] },
      files: [{ path: 'src/app/main.py', content: 'from .missing import X\n' }],
    });
    expect(unresolved.length).toBeGreaterThan(0);
  });

  describe('Cython (.pyx/.pxd)', () => {
    it('extracts regular Python imports from .pyx files (incl. relative + local)', async () => {
      const cy: SourceFile[] = [
        { path: 'algos.pyx', content: 'import sibling\nfrom .util import helper\ndef f():\n    import inner\n' },
        { path: 'sibling.pyx', content: 'x = 1\n' },
        { path: 'util.pxd', content: 'cdef int helper()\n' },
        { path: 'inner.pyx', content: 'y = 2\n' },
      ];
      const { edges } = await pythonImporter.extract({
        codeDirs: ['.'],
        files: cy,
        ownership: { a: cy.map((f) => f.path) },
      });
      expect(new Set(edges.map((e) => `${e.import} -> ${e.toFile}`))).toEqual(
        new Set([
          'sibling -> sibling.pyx', // absolute
          'util -> util.pxd', // relative from .util — resolves to the .pxd
          'inner -> inner.pyx', // inside def body
        ]),
      );
    });

    it('keeps cimport blind AND does not swallow neighboring real imports', async () => {
      // regression for the error-recovery swallow: tree-sitter-python merges `from X cimport Y`
      // into one erroring import_from_statement that EATS the next real from-import.
      const cy: SourceFile[] = [
        { path: 'impl.pyx', content: 'from libc.stdlib cimport malloc\ncimport numpy as cnp\nfrom mypkg.utils import helper\nimport sibling\n' },
        { path: 'sibling.pyx', content: 'x = 1\n' },
        { path: 'mypkg/__init__.py', content: '' },
        { path: 'mypkg/utils.py', content: 'def helper(): pass\n' },
      ];
      const { edges, unresolved } = await pythonImporter.extract({
        codeDirs: ['.'],
        files: cy,
        ownership: { a: cy.map((f) => f.path) },
      });
      expect(new Set(edges.map((e) => `${e.import} -> ${e.toFile}`))).toEqual(
        new Set([
          'mypkg.utils -> mypkg/utils.py', // survived the cimport swallow
          'sibling -> sibling.pyx',
        ]),
      );
      expect(unresolved).toHaveLength(0); // cimport lines: no edges, no unresolved noise
    });

    it('resolves Python imports of Cython modules — .pyx impl wins over .pxd (pandas case)', async () => {
      const files: SourceFile[] = [
        { path: 'pandas/_libs/__init__.py', content: '' },
        { path: 'pandas/_libs/algos.pyx', content: 'cdef int x\n' },
        { path: 'pandas/_libs/algos.pxd', content: 'cdef extern from "algos.h":\n    int foo()\n' },
        { path: 'pandas/core.py', content: 'from pandas._libs import algos\n' },
      ];
      const { edges, unresolved } = await pythonImporter.extract({
        codeDirs: ['pandas'],
        files,
        ownership: { a: files.map((f) => f.path) },
      });
      const viaAlgos = edges.find((e) => e.import === 'pandas._libs.algos');
      expect(viaAlgos).toBeDefined();
      expect(viaAlgos!.toFile).toBe('pandas/_libs/algos.pyx');
      expect(unresolved).toHaveLength(0);
    });

    it('fileToModule strips .pyx/.pxd and treats __init__.pyx as a package', () => {
      expect(fileToModule('src/algos.pyx')).toBe('src.algos');
      expect(fileToModule('src/algos.pxd')).toBe('src.algos');
      expect(fileToModule('pkg/__init__.pyx')).toBe('pkg');
      expect(fileToModule('src/algos.pyx', 'src')).toBe('algos');
    });

    it('relative imports inside __init__.pyx resolve from the package itself (ocr fix)', async () => {
      const files: SourceFile[] = [
        { path: 'pkg/__init__.pyx', content: 'from . import bar\n' },
        { path: 'pkg/bar.pyx', content: 'x = 1\n' },
      ];
      const { edges, unresolved } = await pythonImporter.extract({
        codeDirs: ['.'],
        files,
        ownership: { a: files.map((f) => f.path) },
      });
      expect(edges.map((e) => `${e.import} -> ${e.toFile}`)).toEqual(['pkg.bar -> pkg/bar.pyx']);
      expect(unresolved).toHaveLength(0);
    });
  });
});
