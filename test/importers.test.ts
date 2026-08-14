import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORTERS, importableExts, selectImporters, uncoveredImporterExts } from '../src/importers.js';
import type { Importer } from '../src/imports.js';
import { pythonImporter } from '../src/languages/python.js';

describe('importer selection', () => {
  it('selects only importers whose extensions are present', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    const py: Importer = {
      name: 'py',
      extensions: ['.py'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(selectImporters(['.ts'], [ts, py])).toEqual([ts]);
    expect(selectImporters(['.py'], [ts, py])).toEqual([py]);
    expect(selectImporters(['.ts', '.py'], [ts, py])).toEqual([ts, py]);
  });

  it('selects nothing for an unsupported extension (graceful — no edges)', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(selectImporters(['.go'], [ts])).toEqual([]);
  });

  it('python importer is registered with the .py extension', async () => {
    expect(pythonImporter.extensions).toContain('.py');
    // the registry, not just the object: python must ride in DEFAULT_IMPORTERS (what the
    // pipeline actually dispatches — an unregistered importer would silently skip .py files)
    expect(DEFAULT_IMPORTERS).toContain(pythonImporter);
    const { edges } = await pythonImporter.extract({ codeDirs: ['src'], files: [] });
    expect(edges).toEqual([]);
  });
});

describe('uncoveredImporterExts', () => {
  it('returns extensions no importer covers', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    const py: Importer = {
      name: 'py',
      extensions: ['.py'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(uncoveredImporterExts(['.rs'], [ts, py])).toEqual(['.rs']);
    expect(uncoveredImporterExts(['.ts', '.py'], [ts, py])).toEqual([]);
  });

  it('sorts and dedupes the uncovered extensions', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(uncoveredImporterExts(['.ts', '.rs', '.go', '.rs'], [ts])).toEqual(['.go', '.rs']);
  });

  it('returns [] when every extension is covered', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts', '.js'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(uncoveredImporterExts(['.ts', '.js'], [ts])).toEqual([]);
  });
});

describe('importableExts', () => {
  it('keeps only extensions with an importer, preserving order', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts', '.js'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    const py: Importer = {
      name: 'py',
      extensions: ['.py'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(importableExts(['.py', '.h', '.ts', '.rb'], [ts, py])).toEqual(['.py', '.ts']);
  });

  it('returns [] when nothing is importable (the cmdInit all-blind guard handles that)', () => {
    const ts: Importer = {
      name: 'ts',
      extensions: ['.ts'],
      async extract() {
        return { edges: [], unresolved: [] };
      },
    };
    expect(importableExts(['.c', '.h'], [ts])).toEqual([]);
  });
});
