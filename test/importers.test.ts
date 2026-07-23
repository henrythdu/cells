import { describe, it, expect } from 'vitest';
import { selectImporters, uncoveredImporterExts, pythonImporter } from '../src/importers.js';
import type { Importer } from '../src/crossings.js';

describe('importer selection', () => {
  it('selects only importers whose extensions are present', () => {
    const ts: Importer = { extensions: ['.ts'], async extract() { return []; } };
    const py: Importer = { extensions: ['.py'], async extract() { return []; } };
    expect(selectImporters(['.ts'], [ts, py])).toEqual([ts]);
    expect(selectImporters(['.py'], [ts, py])).toEqual([py]);
    expect(selectImporters(['.ts', '.py'], [ts, py])).toEqual([ts, py]);
  });

  it('selects nothing for an unsupported extension (graceful — no edges)', () => {
    const ts: Importer = { extensions: ['.ts'], async extract() { return []; } };
    expect(selectImporters(['.go'], [ts])).toEqual([]);
  });

  it('python importer is registered but stubbed (no edges until tree-sitter)', async () => {
    expect(pythonImporter.extensions).toContain('.py');
    const edges = await pythonImporter.extract({ codeDirs: ['src'], files: [], ownership: {} });
    expect(edges).toEqual([]);
  });
});

describe('uncoveredImporterExts', () => {
  it('returns extensions no importer covers', () => {
    const ts: Importer = { extensions: ['.ts'], async extract() { return []; } };
    const py: Importer = { extensions: ['.py'], async extract() { return []; } };
    expect(uncoveredImporterExts(['.rs'], [ts, py])).toEqual(['.rs']);
    expect(uncoveredImporterExts(['.ts', '.py'], [ts, py])).toEqual([]);
  });

  it('sorts and dedupes the uncovered extensions', () => {
    const ts: Importer = { extensions: ['.ts'], async extract() { return []; } };
    expect(uncoveredImporterExts(['.ts', '.rs', '.go', '.rs'], [ts])).toEqual(['.go', '.rs']);
  });

  it('returns [] when every extension is covered', () => {
    const ts: Importer = { extensions: ['.ts', '.js'], async extract() { return []; } };
    expect(uncoveredImporterExts(['.ts', '.js'], [ts])).toEqual([]);
  });
});
