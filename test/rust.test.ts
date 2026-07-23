import { describe, it, expect } from 'vitest';
import { rustImporter, fileToModule, resolveImportPath } from '../src/rust.js';
import type { SourceFile } from '../src/crossings.js';
import type { Ownership } from '../src/ownership.js';

describe('fileToModule', () => {
  it('derives Rust module paths from file paths', () => {
    expect(fileToModule('src/lib.rs')).toBe('crate');
    expect(fileToModule('src/main.rs')).toBe('crate');
    expect(fileToModule('src/cli.rs')).toBe('crate::cli');
    expect(fileToModule('src/app/mod.rs')).toBe('crate::app');
    expect(fileToModule('src/reading/tokenization.rs')).toBe('crate::reading::tokenization');
    expect(fileToModule('src/config/themes/catppuccin.rs')).toBe('crate::config::themes::catppuccin');
  });
});

describe('resolveImportPath', () => {
  const m2f = new Map<string, string>([
    ['crate', 'src/lib.rs'],
    ['crate::app', 'src/app/mod.rs'],
    ['crate::reading', 'src/reading/mod.rs'],
    ['crate::reading::tokenization', 'src/reading/tokenization.rs'],
    ['crate::config', 'src/config/mod.rs'],
  ]);

  it('resolves crate:: to the longest matching module (item or module itself)', () => {
    // item in a submodule → the submodule file
    expect(resolveImportPath('crate::reading::tokenization::Token', 'crate::app', m2f)).toBe('src/reading/tokenization.rs');
    // item in a module → the module file
    expect(resolveImportPath('crate::app::App', 'crate::cli', m2f)).toBe('src/app/mod.rs');
    // the root itself
    expect(resolveImportPath('crate', 'crate::cli', m2f)).toBe('src/lib.rs');
  });

  it('resolves super::/self:: relative to the importer module', () => {
    expect(resolveImportPath('self::tokenization', 'crate::reading', m2f)).toBe('src/reading/tokenization.rs');
    expect(resolveImportPath('super::tokenization', 'crate::reading::state', m2f)).toBe('src/reading/tokenization.rs');
    expect(resolveImportPath('super::Config', 'crate::config::file', m2f)).toBe('src/config/mod.rs');
  });

  it('drops external crates (std/serde/…)', () => {
    expect(resolveImportPath('std::path::PathBuf', 'crate::cli', m2f)).toBe(null);
    expect(resolveImportPath('serde::Deserialize', 'crate::cli', m2f)).toBe(null);
  });

  it('returns null for unresolvable internal paths', () => {
    expect(resolveImportPath('crate::nonexistent::X', 'crate::cli', m2f)).toBe(null);
  });
});

describe('rust importer', () => {
  it('extracts crate:: + groups + super:: + re-exports, drops external/unresolved', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod app;\npub mod reading;\nuse crate::app::App;\n' },
      { path: 'src/app/mod.rs', content: 'use crate::reading::tokenization::{tokenize_text, ReadingState};\nuse crate::config::Config;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod tokenization;\npub use crate::reading::tokenization::ReadingState;\n' },
      { path: 'src/reading/tokenization.rs', content: 'pub struct ReadingState {}\npub fn tokenize_text() {}\n' },
      { path: 'src/config/mod.rs', content: 'pub struct Config {}\n' },
      { path: 'src/config/file.rs', content: 'use super::Config;\n' },
      { path: 'src/cli.rs', content: 'use std::path::PathBuf;\nuse crate::nonexistent::X;\n' },
    ];
    const ownership: Ownership = {
      root: ['src/lib.rs'],
      app: ['src/app/mod.rs'],
      reading: ['src/reading/mod.rs', 'src/reading/tokenization.rs'],
      config: ['src/config/mod.rs', 'src/config/file.rs'],
      cli: ['src/cli.rs'],
    };

    const edges = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toEqual(
      new Set([
        'src/lib.rs -> src/app/mod.rs',                       // crate::app::App
        'src/app/mod.rs -> src/reading/tokenization.rs',      // group {tokenize_text, ReadingState} → submodule (deduped)
        'src/app/mod.rs -> src/config/mod.rs',                // crate::config::Config
        'src/reading/mod.rs -> src/reading/tokenization.rs',  // pub use re-export
        'src/config/file.rs -> src/config/mod.rs',            // super::Config
      ]),
    );
    // cli.rs has only external + an unresolved crate:: path → no edges
    expect(edges.some((e) => e.fromFile === 'src/cli.rs')).toBe(false);
  });
});
