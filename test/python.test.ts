import { describe, it, expect } from 'vitest';
import { pythonImporter } from '../src/python.js';
import type { SourceFile } from '../src/crossings.js';
import type { Ownership } from '../src/ownership.js';

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
    const edges = await pythonImporter.extract({ codeDirs: ['src'], files, ownership });
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
    const edges = await pythonImporter.extract({
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
});
