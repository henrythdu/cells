import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rustImporter, fileToModule, resolveImportPath } from '../src/rust.js';
import type { SourceFile } from '../src/imports.js';
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

  it('resolves the crate root by walking up for Cargo.toml (monorepo layout)', () => {
    const crate = mkdtempSync(join(tmpdir(), 'cells-crate-'));
    const startCwd = process.cwd();
    try {
      mkdirSync(join(crate, 'src', 'app'), { recursive: true });
      writeFileSync(join(crate, 'Cargo.toml'), '[package]\n');
      process.chdir(crate);
      expect(fileToModule('src/lib.rs')).toBe('crate');
      expect(fileToModule('src/app/mod.rs')).toBe('crate::app');
      expect(fileToModule('src/tokenize.rs')).toBe('crate::tokenize');
    } finally {
      process.chdir(startCwd);
      rmSync(crate, { recursive: true, force: true });
    }
  });

  it('nested crates each resolve to their own root (not the workspace root)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cells-ws-'));
    const startCwd = process.cwd();
    try {
      mkdirSync(join(repo, 'crates', 'one', 'src'), { recursive: true });
      mkdirSync(join(repo, 'crates', 'two', 'src'), { recursive: true });
      writeFileSync(join(repo, 'Cargo.toml'), '[workspace]\n');
      writeFileSync(join(repo, 'crates', 'one', 'Cargo.toml'), '[package]\n');
      writeFileSync(join(repo, 'crates', 'two', 'Cargo.toml'), '[package]\n');
      process.chdir(repo);
      expect(fileToModule('crates/one/src/lib.rs')).toBe('crate');
      expect(fileToModule('crates/two/src/lib.rs')).toBe('crate');
    } finally {
      process.chdir(startCwd);
      rmSync(repo, { recursive: true, force: true });
    }
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

    const { edges } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toEqual(
      new Set([
        'src/lib.rs -> src/app/mod.rs', // crate::app::App
        'src/app/mod.rs -> src/reading/tokenization.rs', // group {tokenize_text, ReadingState} → submodule (deduped)
        'src/app/mod.rs -> src/config/mod.rs', // crate::config::Config
        'src/reading/mod.rs -> src/reading/tokenization.rs', // pub use re-export
        'src/config/file.rs -> src/config/mod.rs', // super::Config
      ]),
    );
    // cli.rs has only external + an unresolved crate:: path → no edges
    expect(edges.some((e) => e.fromFile === 'src/cli.rs')).toBe(false);
  });

  it('surfaces unresolved crate:: paths as diagnostics', async () => {
    const { unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files: [{ path: 'src/cli.rs', content: 'use crate::missing::Thing;\n' }],
      ownership: { cli: ['src/cli.rs'] },
    });
    expect(unresolved.map((u) => u.import)).toContain('crate::missing::Thing');
  });

  it('external crates (std, serde) do not appear in unresolved', async () => {
    const { unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files: [{ path: 'src/lib.rs', content: 'use std::collections::HashMap;\nuse serde::Serialize;\n' }],
      ownership: { lib: ['src/lib.rs'] },
    });
    expect(unresolved).toEqual([]);
  });

  it('resolves deep paths into nested inline mods (headroom pattern — was false unresolved)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod observability;\nuse crate::observability::metric_names::response_status::COMPLETED;\n' },
      { path: 'src/observability.rs', content: 'mod metric_names {\n  mod response_status {\n    pub const COMPLETED: u8 = 1;\n  }\n}\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files,
      ownership: { lib: ['src/lib.rs'], observability: ['src/observability.rs'] },
    });
    // the deep path resolves to the file containing the deepest module
    expect(edges).toContainEqual({ fromFile: 'src/lib.rs', toFile: 'src/observability.rs', import: 'crate::observability::metric_names::response_status::COMPLETED' });
    expect(unresolved).toEqual([]);
  });

  it('inline mods inside a file-module resolve through the standard `name/` dir', async () => {
    // rust semantics: `mod engine;` in src/observability.rs lives at src/observability/engine.rs
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod observability;\n' },
      { path: 'src/observability.rs', content: 'mod engine;\n' },
      { path: 'src/observability/engine.rs', content: 'mod inner { pub fn run() {} }\n' },
      { path: 'src/cli.rs', content: 'use crate::observability::engine::inner::run;\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files,
      ownership: { lib: ['src/lib.rs'], observability: ['src/observability.rs'], cli: ['src/cli.rs'] },
    });
    // deep chain: observability (file) → engine (name/ dir) → inner (inline) — resolves to engine.rs
    expect(edges).toContainEqual({ fromFile: 'src/cli.rs', toFile: 'src/observability/engine.rs', import: 'crate::observability::engine::inner::run' });
    expect(unresolved).toEqual([]);
  });

  it('workspace crates get namespaced modules — no `crate` key collisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cells-ws-ns-'));
    const startCwd = process.cwd();
    try {
      // real Cargo.toml files on disk — fileToModule probes the FS for crate roots
      mkdirSync(join(root, 'crates', 'a', 'src'), { recursive: true });
      mkdirSync(join(root, 'crates', 'b', 'src'), { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n');
      writeFileSync(join(root, 'crates', 'a', 'Cargo.toml'), '[package]\n');
      writeFileSync(join(root, 'crates', 'b', 'Cargo.toml'), '[package]\n');
      process.chdir(root);
      const files: SourceFile[] = [
        { path: 'crates/a/src/lib.rs', content: 'mod helper;\nuse crate::helper::f;\n' },
        { path: 'crates/a/src/helper.rs', content: 'pub fn f() {}\n' },
        { path: 'crates/b/src/lib.rs', content: 'mod helper;\nuse crate::helper::g;\n' },
        { path: 'crates/b/src/helper.rs', content: 'pub fn g() {}\n' },
      ];
      const { edges, unresolved } = await rustImporter.extract({
        codeDirs: ['crates'],
        files,
        ownership: { a: ['crates/a/src/lib.rs', 'crates/a/src/helper.rs'], b: ['crates/b/src/lib.rs', 'crates/b/src/helper.rs'] },
      });
      // each crate's `crate::helper` resolves to ITS OWN helper.rs (namespaced keys)
      expect(edges).toContainEqual({ fromFile: 'crates/a/src/lib.rs', toFile: 'crates/a/src/helper.rs', import: 'crate::helper::f' });
      expect(edges).toContainEqual({ fromFile: 'crates/b/src/lib.rs', toFile: 'crates/b/src/helper.rs', import: 'crate::helper::g' });
      expect(unresolved).toEqual([]);
    } finally {
      process.chdir(startCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('single crate at the scan root keeps plain `crate::…` keys (off-by-one regression)', () => {
    // cwd matters: findCrateRoot('src/lib.rs') → '.', must NOT slice the path (was 'c/lib.rs')
    const root = mkdtempSync(join(tmpdir(), 'cells-crate-root-'));
    const startCwd = process.cwd();
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'Cargo.toml'), '[package]\n');
      process.chdir(root);
      expect(fileToModule('src/lib.rs')).toBe('crate');
      expect(fileToModule('src/app/mod.rs')).toBe('crate::app');
    } finally {
      process.chdir(startCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
