import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../../src/imports.js';
import { fileToModule, pythonImporter } from '../../src/languages/python.js';

const files: SourceFile[] = [
  { path: 'src/domain/symbol.py', content: 'class Symbol: pass\n' },
  { path: 'src/domain/graph.py', content: 'from src.domain.symbol import Symbol\n' },
  { path: 'src/stages/build.py', content: 'from src.domain.symbol import Symbol\nimport src.domain.graph\n' },
  { path: 'src/stages/rel.py', content: 'from . import sibling\nfrom ..domain.symbol import Sym\n' },
  { path: 'src/stages/sibling.py', content: 'x = 1\n' },
  { path: 'src/stages/ext.py', content: 'import numpy\nfrom os import path\n' },
];

describe('python importer', () => {
  it('namespace attributes attach first-tail symbols; dotted-plain + from-symbol + computed excluded', async () => {
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/views.py', content: 'PORTIONS = 1\n_private = 2\n' },
        { path: 'src/pkg/__init__.py', content: '\n' },
        { path: 'src/pkg/mod.py', content: 'ITEM = 1\n' },
        {
          path: 'src/app.py',
          content: [
            'import src.views',
            'import src.views as v',
            'import src.pkg',
            'from src.pkg import mod',
            'from src.views import PORTIONS',
            'src.views.PORTIONS',
            'v._private',
            'src.pkg.sub.deep',
            'src.attr', // A plain dotted import at the top: there is no `src` edge, so the result is silence (the `os.path` rule).
            'mod.ITEM', // A from-submodule import: the edge `src.pkg.mod` exists, so the name attaches.
            'PORTIONS.foo', // A from-symbol import: there is no edge `src.views.PORTIONS`, so the name drops.
            "src.views['dyn']", // A computed access is excluded.
            '',
          ].join('\n'),
        },
        {
          path: 'src/pkg/user.py',
          content: 'from . import mod\nmod.ITEM\n', // A relative from-submodule import attaches.
        },
      ],
    });
    const sym = new Map(edges.filter((e) => e.symbols?.length).map((e) => [`${e.fromFile} | ${e.import}`, e.symbols]));
    expect(sym.get('src/app.py | src.views')).toEqual(['PORTIONS', '_private']);
    expect(sym.get('src/app.py | src.pkg.mod')).toEqual(['ITEM']);
    expect(sym.get('src/app.py | src.pkg')).toEqual(['sub']); // The chain traverses a real edge, so the attempt is honest visibility.
    expect(sym.get('src/pkg/user.py | src.pkg.mod')).toEqual(['ITEM']);
    // The edge of a from-symbol carries its names through the existing mechanism, and not through the pilot.
    expect(sym.get('src/pkg/user.py | src.pkg')).toEqual(['mod']);
    // A dotted plain import at the top, a from-symbol tail, and a computed access attach nothing anywhere.
    for (const [k, v] of sym) {
      expect(v).not.toContain('attr');
      expect(v).not.toContain('foo');
      expect(v).not.toContain('dyn');
      if (k !== 'src/app.py | src.views' && k !== 'src/app.py | src.pkg' && k !== 'src/app.py | src.pkg.mod' && k !== 'src/pkg/user.py | src.pkg.mod' && k !== 'src/pkg/user.py | src.pkg') {
        throw new Error(`unexpected symbol edge ${k} -> ${JSON.stringify(v)}`);
      }
    }
  });

  it('shadowed import binding misattributes openly (file-level bindings, stated caveat)', async () => {
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/views.py', content: 'REAL = 1\n' },
        { path: 'src/app.py', content: 'import src.views\ndef f(src):\n    return src.views.FAKE\n' },
      ],
    });
    // The parameter `src` shadows the module, and the pilot still attributes FAKE, because there is no scope tracking. The test pins this documented boundary: the result is never a crash and never a false edge.
    const sym = edges.filter((e) => e.symbols?.length);
    expect(sym).toEqual([{ fromFile: 'src/app.py', toFile: 'src/views.py', import: 'src.views', symbols: ['FAKE'] }]);
  });
  it('extracts absolute + relative edges, drops external', async () => {
    const { edges } = await pythonImporter.extract({ codeDirs: ['src'], files });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile} | ${e.import}`));
    expect(set).toEqual(
      new Set([
        'src/domain/graph.py -> src/domain/symbol.py | src.domain.symbol', // An internal domain import.
        'src/stages/build.py -> src/domain/symbol.py | src.domain.symbol', // A cross import from stages to domain (absolute).
        'src/stages/build.py -> src/domain/graph.py | src.domain.graph', // A cross import from stages to domain (`import M`).
        'src/stages/rel.py -> src/stages/sibling.py | src.stages.sibling', // An internal import in stages (`from . import`).
        'src/stages/rel.py -> src/domain/symbol.py | src.domain.symbol', // A cross import from stages to domain (`from ..M`).
      ]),
    );
  });

  it('handles `import a, b.c` (multiple modules) and `as` aliases', async () => {
    const { edges } = await pythonImporter.extract({
      codeDirs: ['src'],
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
      files: [
        { path: 'app/cli.py', content: pySrc },
        { path: 'src/stages/predict.py', content: 'def main(): pass\n' },
        { path: 'src/stages/enrich.py', content: 'def main(): pass\n' },
      ],
    });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toEqual(new Set(['app/cli.py -> src/stages/predict.py', 'app/cli.py -> src/stages/enrich.py']));
  });

  it('silences imports backed by compiled extension modules on disk (pyo3 _core.so)', async () => {
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
      });
      expect(unresolved.some((u) => u.import === 'headroom._core')).toBe(false); // The `.so` file exists on disk, so the result is silence.
      expect(unresolved.some((u) => u.import === 'headroom.transforms')).toBe(false); // The import resolves normally.
    } finally {
      process.chdir(prev);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('compiled-module probe is baseDir-scoped — two trees probing one cache cannot collide', async () => {
    // The two trees have the same relative layout, and only tree A has the compiled `_core.so` on disk. The probe cache is keyed by `resolve(baseDir, dir)`. A relative key would let tree B inherit the hit of tree A and silently swallow a REAL unresolved import.
    const files: SourceFile[] = [
      { path: 'headroom/__init__.py', content: '\n' },
      { path: 'headroom/transforms/smart_crusher.py', content: 'from headroom._core import X\nfrom headroom.transforms import Y\n' },
    ];
    const mk = (withSo: boolean): string => {
      const repo = mkdtempSync(join(tmpdir(), 'cells-pyscope-'));
      mkdirSync(join(repo, 'headroom', 'transforms'), { recursive: true });
      if (withSo) writeFileSync(join(repo, 'headroom', '_core.cpython-312-x86_64-linux-gnu.so'), 'binary\n');
      return repo;
    };
    const a = mk(true);
    const b = mk(false);
    try {
      const ra = await pythonImporter.extract({ codeDirs: ['headroom'], baseDir: a, files });
      const rb = await pythonImporter.extract({ codeDirs: ['headroom'], baseDir: b, files });
      expect(ra.unresolved.some((u) => u.import === 'headroom._core')).toBe(false); // The `.so` file exists on disk, so the result is silence.
      expect(rb.unresolved.some((u) => u.import === 'headroom._core')).toBe(true); // There is no `.so` file in B, so the result is an honest unresolved import.
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
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
      files: [
        { path: 'src/domain/symbol.py', content: 'class X: pass\n' },
        { path: 'src/app/main.py', content: 'from domain.symbol import X\n' },
      ],
    });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toContain('src/app/main.py -> src/domain/symbol.py');
  });

  it('WITHOUT module-root, an unambiguous src-layout import still resolves (physical target, unique, same code-dir family)', async () => {
    // The probe proves that `src/domain/symbol.py` exists, and the map has exactly one key `.domain.symbol` in the family of the importer. The resolution is provable, so the tool takes it instead of flagging. `module-root` stays the answer for an ambiguous case.
    const { edges, unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/domain/symbol.py', content: 'class X: pass\n' },
        { path: 'src/app/main.py', content: 'from domain.symbol import X\n' },
      ],
    });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toContain('src/app/main.py -> src/domain/symbol.py');
    expect(unresolved).toEqual([]);
  });
});

describe('unresolved local imports', () => {
  it('surfaces local imports that do not resolve to any file', async () => {
    const { unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      moduleRoot: 'src',
      files: [{ path: 'src/domain/symbol.py', content: 'from domain.missing import X\n' }],
    });
    expect(unresolved.map((u) => u.import)).toContain('domain.missing');
  });

  it('external packages do not appear in unresolved', async () => {
    const { unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      files: [{ path: 'src/app.py', content: 'import numpy\nfrom openai import X\n' }],
    });
    expect(unresolved).toEqual([]);
  });

  it('self-package absolute import (`python -m uv` style): code-dir-prefixed map, bare-name import resolves', async () => {
    const { edges, unresolved } = await pythonImporter.extract({
      codeDirs: ['python'],
      files: [
        { path: 'python/uv/__init__.py', content: 'def find_uv_bin(): return 1\n' },
        { path: 'python/uv/__main__.py', content: 'from uv import find_uv_bin\n' },
      ],
    });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toContain('python/uv/__main__.py -> python/uv/__init__.py');
    expect(unresolved).toEqual([]);
  });

  it('ambiguous self-name (two same-family packages share it) stays unresolved — never guess', async () => {
    const { edges, unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/uv/__init__.py', content: 'x = 1\n' },
        { path: 'src/gen/uv/__init__.py', content: 'y = 2\n' },
        { path: 'src/app/__main__.py', content: 'from uv import x\n' },
      ],
    });
    expect(edges).toEqual([]);
    expect(unresolved.map((u) => u.import)).toContain('uv');
  });

  it('src-layout WITHOUT module-root: unambiguous imports resolve; cross-family ones stay flagged', async () => {
    // The src layout: `fileToModule` derives `src.util`, while the import says `util`. The first
    // segment is not a local package, so the old code classified the import as external and
    // silently dropped it, and the gate showed "0 edges" on a repository full of imports.
    // Physical existence under a code directory beats the silence of the map. A unique match in
    // the same family resolves, and a match in a different family (`tests` to `src.core.engine`)
    // stays unresolved with a hint about module-root, instead of a guess.
    const { edges, unresolved } = await pythonImporter.extract({
      codeDirs: ['src', 'tests'],
      files: [
        { path: 'src/core/engine.py', content: 'from util import setup\n' },
        { path: 'src/util.py', content: 'def setup(): return 1\n' },
        { path: 'tests/test_engine.py', content: 'from core.engine import run\n' },
      ],
    });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toContain('src/core/engine.py -> src/util.py');
    expect(unresolved.map((u) => u.import)).toEqual(expect.arrayContaining(['core.engine']));
    expect(unresolved.map((u) => u.import)).not.toContain('util');
  });

  it('same fixture WITH module-root: the imports resolve to real edges', async () => {
    const { edges, unresolved } = await pythonImporter.extract({
      codeDirs: ['src', 'tests'],
      moduleRoot: 'src',
      files: [
        { path: 'src/core/engine.py', content: 'from util import setup\n' },
        { path: 'src/util.py', content: 'def setup(): return 1\n' },
        { path: 'tests/test_engine.py', content: 'from core.engine import run\n' },
      ],
    });
    expect(unresolved).toEqual([]);
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toEqual(new Set(['src/core/engine.py -> src/util.py', 'tests/test_engine.py -> src/core/engine.py']));
  });

  it('first segment exists as a DIRECTORY under a code-dir → resolves when unique (package mismatch without a module-root)', async () => {
    const { edges, unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
      files: [
        { path: 'src/app.py', content: 'import helpers.norm\n' },
        { path: 'src/helpers/norm.py', content: 'x = 1\n' },
      ],
    });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toContain('src/app.py -> src/helpers/norm.py');
    expect(unresolved).toEqual([]);
  });

  it('relative imports that do not resolve are flagged', async () => {
    const { unresolved } = await pythonImporter.extract({
      codeDirs: ['src'],
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
      });
      expect(new Set(edges.map((e) => `${e.import} -> ${e.toFile}`))).toEqual(
        new Set([
          'sibling -> sibling.pyx', // An absolute import.
          'util -> util.pxd', // A relative import from `.util`, which resolves to the `.pxd` file.
          'inner -> inner.pyx', // Inside a function body.
        ]),
      );
    });

    it('keeps cimport blind AND does not swallow neighboring real imports', async () => {
      // A regression test for the swallow by error recovery: tree-sitter-python merges `from X cimport Y` into one erroring import_from_statement, and that statement EATS the next real from-import.
      const cy: SourceFile[] = [
        { path: 'impl.pyx', content: 'from libc.stdlib cimport malloc\ncimport numpy as cnp\nfrom mypkg.utils import helper\nimport sibling\n' },
        { path: 'sibling.pyx', content: 'x = 1\n' },
        { path: 'mypkg/__init__.py', content: '' },
        { path: 'mypkg/utils.py', content: 'def helper(): pass\n' },
      ];
      const { edges, unresolved } = await pythonImporter.extract({
        codeDirs: ['.'],
        files: cy,
      });
      expect(new Set(edges.map((e) => `${e.import} -> ${e.toFile}`))).toEqual(
        new Set([
          'mypkg.utils -> mypkg/utils.py', // The import survived the swallow of the cimport.
          'sibling -> sibling.pyx',
        ]),
      );
      expect(unresolved).toHaveLength(0); // The cimport lines give no edges and no unresolved noise.
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

    it('relative imports inside __init__.pyx resolve from the package itself', async () => {
      const files: SourceFile[] = [
        { path: 'pkg/__init__.pyx', content: 'from . import bar\n' },
        { path: 'pkg/bar.pyx', content: 'x = 1\n' },
      ];
      const { edges, unresolved } = await pythonImporter.extract({
        codeDirs: ['.'],
        files,
      });
      expect(edges.map((e) => `${e.import} -> ${e.toFile}`)).toEqual(['pkg.bar -> pkg/bar.pyx']);
      expect(unresolved).toHaveLength(0);
    });
  });
});
