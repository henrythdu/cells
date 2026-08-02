import { describe, it, expect } from 'vitest';
import type { SourceFile } from '../../src/imports.js';
import { cppImporter, includeCandidates, includeRoots } from '../../src/languages/cpp.js';

/** In-memory fixture — the cpp importer resolves against the census (ctx.files), no FS. */
function files(entries: Record<string, string>): SourceFile[] {
  return Object.entries(entries).map(([path, content]) => ({ path, content }));
}

async function extract(entries: Record<string, string>) {
  return cppImporter.extract({ files: files(entries), codeDirs: ['.'], ownership: {}, moduleRoot: '.', baseDir: '.' });
}

describe('includeRoots (census-derived -I roots)', () => {
  it('lists code-bearing top-level dirs, root first, sorted', () => {
    expect(includeRoots(new Set(['src/a.cpp', 'include/x.h', 'test/t.cc', 'main.c']))).toEqual(['.', 'include', 'src', 'test']);
  });

  it('root-only when every file sits at the top level', () => {
    expect(includeRoots(new Set(['a.c', 'b.h']))).toEqual(['.']);
  });
});

describe('includeCandidates (probe order)', () => {
  it('quoted: importer-dir first, then repo-relative across every root', () => {
    expect(includeCandidates({ path: 'util.h', quoted: true }, 'src/a.cpp', ['.', 'include', 'src'])).toEqual([
      'src/util.h', // importer-dir probe; the src-root probe is the same string → deduped
      'util.h',
      'include/util.h',
    ]);
    expect(includeCandidates({ path: '../inc/x.h', quoted: true }, 'src/a.cpp', ['.', 'inc'])).toEqual(['inc/x.h']); // ../ folds into the dir join; the bare form escapes → dropped
    expect(includeCandidates({ path: './util.h', quoted: true }, 'src/a.cpp', ['.'])).toEqual(['src/util.h', 'util.h']);
  });

  it('angle: repo-relative across every root (no importer-dir probe)', () => {
    expect(includeCandidates({ path: 'project/foo.hpp', quoted: false }, 'src/a.cpp', ['.', 'include'])).toEqual([
      'project/foo.hpp',
      'include/project/foo.hpp',
    ]);
    expect(includeCandidates({ path: 'vector', quoted: false }, 'src/a.cpp', ['.'])).toEqual(['vector']);
  });

  it('drops candidates escaping the repo root', () => {
    expect(includeCandidates({ path: '../../out.h', quoted: true }, 'src/a.cpp', ['.', 'src'])).toEqual([]);
  });
});

describe('cppImporter (include resolution)', () => {
  it('resolves quoted includes importer-dir-relative, then repo-relative', async () => {
    const { edges, unresolved } = await extract({
      'src/a.cpp': '#include "util.h"\n#include "json.hpp"\n',
      'src/util.h': '#pragma once\n',
      'json.hpp': '#pragma once\n', // vendor at repo root — flattened -I hit
    });
    expect(edges.find((e) => e.fromFile === 'src/a.cpp' && e.import === 'util.h')?.toFile).toBe('src/util.h');
    expect(edges.find((e) => e.fromFile === 'src/a.cpp' && e.import === 'json.hpp')?.toFile).toBe('json.hpp');
    expect(unresolved).toEqual([]);
  });

  it('normalizes ../ segments against the including file dir', async () => {
    const { edges } = await extract({
      'src/a.cpp': '#include "../inc/x.h"\n',
      'inc/x.h': '#pragma once\n',
    });
    expect(edges.find((e) => e.import === '../inc/x.h')?.toFile).toBe('inc/x.h');
  });

  it('resolves angle includes that hit the census (own/vendored headers)', async () => {
    const { edges, unresolved } = await extract({
      'src/a.cpp': '#include <project/foo.hpp>\n#include <vector>\n#include <boost/missing.hpp>\n',
      'project/foo.hpp': '#pragma once\n',
    });
    expect(edges.find((e) => e.import === 'project/foo.hpp')?.toFile).toBe('project/foo.hpp');
    expect(unresolved).toEqual([]); // <vector> and <boost/missing.hpp> both external → silent
  });

  it('flags quoted misses as unresolved (broken local include)', async () => {
    const { edges, unresolved } = await extract({
      'src/a.cpp': '#include "missing.h"\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([{ fromFile: 'src/a.cpp', import: 'missing.h' }]);
  });

  it('resolves includes against an include/ root (fmt shape: -I include)', async () => {
    const { edges, unresolved } = await extract({
      'src/format.cc': '#include "fmt/format.h"\n#include <fmt/base.h>\n',
      'include/fmt/format.h': '#pragma once\n#include "fmt/base.h"\n',
      'include/fmt/base.h': '#pragma once\n',
    });
    expect(edges.find((e) => e.import === 'fmt/format.h')?.toFile).toBe('include/fmt/format.h');
    expect(edges.find((e) => e.import === 'fmt/base.h')?.toFile).toBe('include/fmt/base.h');
    expect(unresolved).toEqual([]);
  });

  it('header→header edges work (a header including a sibling)', async () => {
    const { edges } = await extract({
      'include/foo.hpp': '#include "bar.hpp"\n',
      'include/bar.hpp': '#pragma once\n',
    });
    expect(edges.find((e) => e.import === 'bar.hpp')?.toFile).toBe('include/bar.hpp');
  });

  it('covers pure C (.c/.h) with the same rules', async () => {
    const { edges, unresolved } = await extract({
      'src/main.c': '#include <stdio.h>\n#include "local.h"\n',
      'src/local.h': '#define X 1\n',
    });
    expect(edges.find((e) => e.import === 'local.h')?.toFile).toBe('src/local.h');
    expect(edges.find((e) => e.import === 'stdio.h')).toBeUndefined(); // stdlib external
    expect(unresolved).toEqual([]);
  });

  it('handles #ifdef-guarded and repeated includes (static, deduped)', async () => {
    const { edges } = await extract({
      'src/a.cpp': '#ifdef FOO\n#include "x.h"\n#endif\n#include "x.h"\n',
      'src/x.h': '#pragma once\n',
    });
    expect(edges.filter((e) => e.import === 'x.h')).toHaveLength(1); // factory dedupes dup targets
  });

  it('macro includes and #include_next are skipped (no literal child)', async () => {
    const { edges, unresolved } = await extract({
      'src/a.cpp': '#include TARGET\n#include_next <stdio.h>\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
