import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../../src/imports.js';
import { fileToModule, resolveImportPath, rustImporter } from '../../src/languages/rust.js';

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

  it('a [[bin]] path dir without its own Cargo.toml is its own crate root (ripgrep layout)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cells-bin-'));
    const startCwd = process.cwd();
    try {
      mkdirSync(join(repo, 'core', 'flags'), { recursive: true });
      // The workspace root: a `[package]` section and a `[[bin]]` target for `core/main.rs`. The directory `core/` has no manifest.
      writeFileSync(join(repo, 'Cargo.toml'), '[package]\nname = "rg"\n\n[[bin]]\nname = "rg"\npath = "core/main.rs"\n');
      writeFileSync(join(repo, 'core', 'main.rs'), 'mod flags;\n');
      writeFileSync(join(repo, 'core', 'flags', 'mod.rs'), 'pub mod defs;\n');
      writeFileSync(join(repo, 'core', 'flags', 'defs.rs'), 'pub struct Flags;\n');
      process.chdir(repo);
      // The bin directory is the crate root, so the modules derive from `core/` and not from the flags of the repository root.
      expect(fileToModule('core/main.rs')).toBe('crate');
      expect(fileToModule('core/flags/defs.rs')).toBe('crate::flags::defs');
      // A file at the root still belongs to the root package.
      expect(fileToModule('build.rs')).toBe('crate::build');
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
    // An item in a submodule maps to the file of the submodule.
    expect(resolveImportPath('crate::reading::tokenization::Token', 'crate::app', m2f)).toBe('src/reading/tokenization.rs');
    // An item in a module maps to the file of the module.
    expect(resolveImportPath('crate::app::App', 'crate::cli', m2f)).toBe('src/app/mod.rs');
    // The root itself.
    expect(resolveImportPath('crate', 'crate::cli', m2f)).toBe('src/lib.rs');
  });

  it('resolves super::/self:: relative to the importer module', () => {
    expect(resolveImportPath('self::tokenization', 'crate::reading', m2f)).toBe('src/reading/tokenization.rs');
    expect(resolveImportPath('super::tokenization', 'crate::reading::state', m2f)).toBe('src/reading/tokenization.rs');
    expect(resolveImportPath('super::Config', 'crate::config::file', m2f)).toBe('src/config/mod.rs');
  });

  it('resolves super:: landing exactly on the namespaced crate root (multi-crate workspace)', () => {
    // The files `crates/a/src/lib.rs` and `mod helper`. In `helper.rs`, `use super::Thing;` takes `super` to the crate root.
    const ws = new Map<string, string>([
      ['crates/a', 'crates/a/src/lib.rs'],
      ['crates/a::helper', 'crates/a/src/helper.rs'],
    ]);
    expect(resolveImportPath('super::Thing', 'crates/a::helper', ws)).toBe('crates/a/src/lib.rs');
    expect(resolveImportPath('super::super::Thing', 'crates/a::b::c', ws)).toBe('crates/a/src/lib.rs');
    // A pop of the root itself still escapes.
    expect(resolveImportPath('super::Thing', 'crates/a', ws)).toBe(null);
    expect(resolveImportPath('super::super::super::Thing', 'crates/a::b::c', ws)).toBe(null);
  });

  it('drops external crates (std/serde/…)', () => {
    expect(resolveImportPath('std::path::PathBuf', 'crate::cli', m2f)).toBe(null);
    expect(resolveImportPath('serde::Deserialize', 'crate::cli', m2f)).toBe(null);
  });

  it('returns null for unresolvable internal paths', () => {
    expect(resolveImportPath('crate::nonexistent::X', 'crate::cli', m2f)).toBe(null);
  });

  it('anchors crate:: to the TEST crate root for integration-test files (uv-client)', async () => {
    // `tests/it/ssl_certs.rs` uses `crate::http_util::SelfSigned`. The module `http_util` belongs to the TEST crate (`tests/it.rs`), not to the library, so `crate::` must anchor to the test root.
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod app;\n' },
      { path: 'src/app.rs', content: 'pub struct LibOnly;\n' },
      { path: 'tests/it.rs', content: 'mod ssl_certs;\nmod http_util;\n' },
      { path: 'tests/it/ssl_certs.rs', content: 'use crate::http_util::SelfSigned;\n' },
      { path: 'tests/it/http_util.rs', content: 'pub struct SelfSigned;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['.'], files });
    const viaTestRoot = edges.find((e) => e.import === 'crate::http_util::SelfSigned');
    expect(viaTestRoot).toBeDefined();
    expect(viaTestRoot!.toFile).toBe('tests/it/http_util.rs'); // It is a module of the TEST crate, and not of the library.
    expect(unresolved).toHaveLength(0);
  });

  it('resolves enum-variant / deep item chains to the deepest real module', () => {
    // A use path names a variant of an enum in the module `crate::token`. The variant lives in the file of that module, so the resolver drops two segments and not one.
    expect(resolveImportPath('crate::reading::tokenization::Token::Kind', 'crate::app', m2f)).toBe('src/reading/tokenization.rs');
    // A missing module in the middle of the chain under a real module resolves to the deepest real module. The shape is the same as a variant path, and the code cannot tell the two apart without type information.
    expect(resolveImportPath('crate::reading::missing::Thing', 'crate::app', m2f)).toBe('src/reading/mod.rs');
    // The path never falls back to the crate root, because there is no intermediate module at all, so the result stays null.
    expect(resolveImportPath('crate::nope::Thing', 'crate::app', m2f)).toBe(null);
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

    const { edges } = await rustImporter.extract({ codeDirs: ['src'], files });
    const set = new Set(edges.map((e) => `${e.fromFile} -> ${e.toFile}`));
    expect(set).toEqual(
      new Set([
        'src/lib.rs -> src/app/mod.rs', // The path `crate::app::App`.
        'src/app/mod.rs -> src/reading/tokenization.rs', // The group `{tokenize_text, ReadingState}` gives the submodule, deduplicated.
        'src/app/mod.rs -> src/config/mod.rs', // The path `crate::config::Config`.
        'src/reading/mod.rs -> src/reading/tokenization.rs', // A pub use re-export.
        'src/config/file.rs -> src/config/mod.rs', // The path `super::Config`.
      ]),
    );
    // The file `cli.rs` has only an external import and an unresolved `crate::` path, so it has no edges.
    expect(edges.some((e) => e.fromFile === 'src/cli.rs')).toBe(false);
  });

  it('surfaces unresolved crate:: paths as diagnostics', async () => {
    const { unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files: [{ path: 'src/cli.rs', content: 'use crate::missing::Thing;\n' }],
    });
    expect(unresolved.map((u) => u.import)).toContain('crate::missing::Thing');
  });

  it('reports a `mod` whose file is missing, and does not point at the declaring file', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod missing;\n' },
      { path: 'src/app.rs', content: 'use crate::missing::Thing;\npub fn go() {}\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(edges).toEqual([]);
    expect(unresolved.map((u) => u.import)).toEqual(['crate::missing::Thing']);
  });

  it('still maps an inline `mod` block to its own file', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod inline { pub struct Thing; }\n' },
      { path: 'src/app.rs', content: 'use crate::inline::Thing;\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(edges.map((e) => `${e.fromFile} -> ${e.toFile}`)).toEqual(['src/app.rs -> src/lib.rs']);
    expect(unresolved).toEqual([]);
  });

  it('resolves a `mod` whose file is named by `#[path]`', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: '#[path = "custom/x.rs"]\nmod x;\n' },
      { path: 'src/custom/x.rs', content: 'pub struct Y;\n' },
      { path: 'src/app.rs', content: 'use crate::x::Y;\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(edges.find((e) => e.fromFile === 'src/app.rs')?.toFile).toBe('src/custom/x.rs');
    expect(unresolved).toEqual([]);
  });

  it('keeps `#[path]` when another attribute follows it', async () => {
    // `#[cfg(...)]` commonly sits beside `#[path]` on a platform module, in either order.
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: '#[path = "custom/x.rs"]\n#[cfg(unix)]\nmod x;\n' },
      { path: 'src/custom/x.rs', content: 'pub struct Y;\n' },
      { path: 'src/app.rs', content: 'use crate::x::Y;\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(edges.find((e) => e.fromFile === 'src/app.rs')?.toFile).toBe('src/custom/x.rs');
    expect(unresolved).toEqual([]);
  });

  it('external crates (std, serde) do not appear in unresolved', async () => {
    const { unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files: [{ path: 'src/lib.rs', content: 'use std::collections::HashMap;\nuse serde::Serialize;\n' }],
    });
    expect(unresolved).toEqual([]);
  });

  it('resolves super:: chains inside inline mod blocks (headroom mod tests)', async () => {
    const files: SourceFile[] = [
      { path: 'src/compaction/compactor.rs', content: 'mod tests {\n  use super::super::ir::OpaqueKind;\n}\nuse super::ir::SimpleKind;\n' },
      { path: 'src/compaction/ir.rs', content: 'pub struct OpaqueKind;\npub struct SimpleKind;\n' },
      { path: 'src/ir.rs', content: 'pub struct OpaqueKind;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    const superSuper = edges.find((e) => e.import === 'super::super::ir::OpaqueKind');
    expect(superSuper).toBeDefined();
    expect(superSuper!.toFile).toBe('src/compaction/ir.rs'); // The depth of the mod tests counts, so the target is NOT `src/ir.rs`.
    expect(unresolved).toHaveLength(0);
  });

  it('silences re-exports of EXTERNAL crates — no false unresolved (uv owo_colors)', async () => {
    // uv-warnings has `pub use owo_colors;`, so the re-export leaves the partition. An import that routes through it (`uv_warnings::owo_colors::OwoColorize`) is real code, but no owned file exists to draw an edge to. Such an import must NOT flag as broken local.
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod warnings;\npub mod ui;\n' },
      { path: 'src/warnings.rs', content: 'pub use owo_colors;\n' },
      { path: 'src/ui.rs', content: 'use crate::warnings::owo_colors::OwoColorize;\nuse crate::nope::Thing;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    // The external re-export routes through nothing owned, so there is no edge and no unresolved import.
    expect(edges.find((e) => e.import === 'crate::warnings::owo_colors::OwoColorize')).toBeUndefined();
    // A genuinely broken local import (no intermediate module at all) in the same file still flags.
    expect(unresolved.map((u) => u.import)).toContain('crate::nope::Thing');
    expect(unresolved.filter((u) => u.import.includes('owo_colors'))).toHaveLength(0);
  });

  it('resolves pub use re-export chains (uv_audit::osv::Filter)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod service;\npub use service::osv;\n' },
      { path: 'src/service.rs', content: 'pub mod osv;\n' },
      { path: 'src/service/osv.rs', content: 'pub struct Filter;\n' },
      { path: 'src/other.rs', content: 'use crate::osv::Filter;\nuse crate::service::osv::Filter as Direct;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    const viaAlias = edges.find((e) => e.import === 'crate::osv::Filter');
    expect(viaAlias).toBeDefined();
    expect(viaAlias!.toFile).toBe('src/service/osv.rs');
    expect(unresolved).toHaveLength(0);
  });

  it('honors explicit `as` aliases inside use groups + pub(crate)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod svc;\npub(crate) use svc::{osv as oz, filter};\n' },
      { path: 'src/svc.rs', content: 'pub mod osv;\npub mod filter;\n' },
      { path: 'src/svc/osv.rs', content: 'pub struct Filter;\n' },
      { path: 'src/svc/filter.rs', content: 'pub struct F;\n' },
      { path: 'src/other.rs', content: 'use crate::oz::Filter;\nuse crate::svc::osv::Filter as Direct;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    // `use crate::oz::Filter` resolves through the re-export with the alias, because the explicit `as oz` wins over the last segment `osv`.
    const viaAlias = edges.find((e) => e.import === 'crate::oz::Filter');
    expect(viaAlias).toBeDefined();
    expect(viaAlias!.toFile).toBe('src/svc/osv.rs');
    // There is no false edge under the ORIGINAL name, because `crate::osv` was renamed to `oz`.
    expect(edges.some((e) => e.import === 'crate::osv::Filter')).toBe(false);
    // `pub(crate)` counts as public for the resolution inside the crate.
    expect(unresolved).toHaveLength(0);
  });

  it('does not hijack module references via item aliases (uv: pub use wheel::metadata fn)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod metadata;\nmod wheel;\npub use wheel::metadata;\nuse crate::metadata::ValidationError;\n' },
      { path: 'src/metadata.rs', content: 'pub struct ValidationError;\n' },
      { path: 'src/wheel.rs', content: 'pub fn metadata() {}\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    const direct = edges.find((e) => e.import === 'crate::metadata::ValidationError');
    expect(direct).toBeDefined();
    expect(direct!.toFile).toBe('src/metadata.rs'); // The item alias does NOT hijack the path to `wheel.rs`.
    expect(unresolved).toHaveLength(0);
  });

  it('resolves deep paths into nested inline mods (headroom pattern — was false unresolved)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod observability;\nuse crate::observability::metric_names::response_status::COMPLETED;\n' },
      { path: 'src/observability.rs', content: 'mod metric_names {\n  mod response_status {\n    pub const COMPLETED: u8 = 1;\n  }\n}\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files,
    });
    // The deep path resolves to the file that contains the deepest module.
    expect(edges).toContainEqual({ fromFile: 'src/lib.rs', toFile: 'src/observability.rs', import: 'crate::observability::metric_names::response_status::COMPLETED', symbols: ['COMPLETED'] });
    expect(unresolved).toEqual([]);
  });

  it('inline mods inside a file-module resolve through the standard `name/` dir', async () => {
    // This is the Rust rule: `mod engine;` in `src/observability.rs` lives at `src/observability/engine.rs`.
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod observability;\n' },
      { path: 'src/observability.rs', content: 'mod engine;\n' },
      { path: 'src/observability/engine.rs', content: 'mod inner { pub fn run() {} }\n' },
      { path: 'src/cli.rs', content: 'use crate::observability::engine::inner::run;\n' },
    ];
    const { edges, unresolved } = await rustImporter.extract({
      codeDirs: ['src'],
      files,
    });
    // The deep chain is `observability` (a file), then `engine` (a `name/` directory), then `inner` (inline), and it resolves to `engine.rs`.
    expect(edges).toContainEqual({ fromFile: 'src/cli.rs', toFile: 'src/observability/engine.rs', import: 'crate::observability::engine::inner::run', symbols: ['run'] });
    expect(unresolved).toEqual([]);
  });

  it('workspace crates get namespaced modules — no `crate` key collisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cells-ws-ns-'));
    const startCwd = process.cwd();
    try {
      // Real `Cargo.toml` files on disk, because `fileToModule` probes the file system for crate roots.
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
      });
      // The `crate::helper` path of each crate resolves to ITS OWN `helper.rs`, because the keys are namespaced.
      expect(edges).toContainEqual({ fromFile: 'crates/a/src/lib.rs', toFile: 'crates/a/src/helper.rs', import: 'crate::helper::f', symbols: ['f'] });
      expect(edges).toContainEqual({ fromFile: 'crates/b/src/lib.rs', toFile: 'crates/b/src/helper.rs', import: 'crate::helper::g', symbols: ['g'] });
      expect(unresolved).toEqual([]);
    } finally {
      process.chdir(startCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('single crate at the scan root keeps plain `crate::…` keys (off-by-one regression)', () => {
    // The working directory matters: `findCrateRoot('src/lib.rs')` gives '.', and the code must NOT slice the path. The old code produced 'c/lib.rs'.
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

  it('cross-crate workspace imports resolve to the sibling crate', async () => {
    // In `headroom-cli`, `use headroom_core::...` must resolve to the file of the sibling crate by its NAME and not by its directory path. The old code silently dropped the import as external.
    const root = mkdtempSync(join(tmpdir(), 'cells-ws-x-'));
    const startCwd = process.cwd();
    try {
      mkdirSync(join(root, 'crates', 'headroom-core', 'src', 'signals'), { recursive: true });
      mkdirSync(join(root, 'crates', 'headroom-cli', 'src'), { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n');
      writeFileSync(join(root, 'crates', 'headroom-core', 'Cargo.toml'), '[package]\nname = "headroom-core"\nversion = "0.1.0"\n\n[dependencies]\n');
      writeFileSync(join(root, 'crates', 'headroom-cli', 'Cargo.toml'), '[package]\nname = "headroom-cli"\nversion = "0.1.0"\n');
      process.chdir(root);
      const files: SourceFile[] = [
        { path: 'crates/headroom-core/src/lib.rs', content: 'pub mod signals;\n' },
        { path: 'crates/headroom-core/src/signals/mod.rs', content: 'mod plan;\npub use plan::*;\n' },
        { path: 'crates/headroom-core/src/signals/plan.rs', content: 'pub struct Plan;\n' },
        { path: 'crates/headroom-cli/src/main.rs', content: 'use headroom_core::signals::plan::Plan;\nuse headroom_core::signals::missing::Nope;\nuse crate::missing::Thing;\nuse serde_json::Value;\n' },
      ];
      const { edges, unresolved } = await rustImporter.extract({
        codeDirs: ['crates'],
        files,
      });
      // The cross-crate import resolves to the file of the sibling crate.
      expect(edges).toContainEqual({ fromFile: 'crates/headroom-cli/src/main.rs', toFile: 'crates/headroom-core/src/signals/plan.rs', import: 'headroom_core::signals::plan::Plan', symbols: ['Plan'] });
      // A broken path in the middle of the chain resolves to the deepest real module, because `signals` exists and `missing` does not. The shape is the same as a variant path, and the source alone cannot separate a missing module from an item without type information. The edge lands on the nearest real module, so the agent can inspect it, and a false edge to the bare root is impossible (the path keeps at least 2 segments).
      expect(edges).toContainEqual({ fromFile: 'crates/headroom-cli/src/main.rs', toFile: 'crates/headroom-core/src/signals/mod.rs', import: 'headroom_core::signals::missing::Nope', symbols: ['Nope'] });
      // A broken import of 2 segments in the OWN crate (no intermediate module at all) stays unresolved, which is honest. The path never falls back to the crate root of the importer.
      expect(unresolved).toContainEqual({ fromFile: 'crates/headroom-cli/src/main.rs', import: 'crate::missing::Thing' });
      // serde stays silently external and is never unresolved.
      expect(unresolved).not.toContainEqual(expect.objectContaining({ import: 'serde_json::Value' }));
      // The broken import in the middle of the chain is no longer in the unresolved list.
      expect(unresolved).not.toContainEqual(expect.objectContaining({ import: 'headroom_core::signals::missing::Nope' }));
    } finally {
      process.chdir(startCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rust keyword-module imports (super/self/crate as node types)', () => {
  it('keeps the super prefix on brace-list imports (use super::{A, B}) — no false root edge', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod foo;\n' },
      { path: 'src/foo/mod.rs', content: 'pub enum LoadError { X }\npub struct LoadedDocument;\n' },
      { path: 'src/foo/a.rs', content: 'use super::{LoadError, LoadedDocument};\npub fn f() -> Result<(), LoadError> { Ok(()) }\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(unresolved).toEqual([]);
    // The brace form must resolve in the same way as the dotted form: `super` is `crate::foo`, which gives `foo/mod.rs`. It must NOT fall through to the crate root (`lib.rs`).
    expect(edges).toContainEqual({ fromFile: 'src/foo/a.rs', toFile: 'src/foo/mod.rs', import: 'super::LoadError', symbols: ['LoadError'] });
    expect(edges.some((e) => e.toFile === 'src/lib.rs' && e.fromFile === 'src/foo/a.rs')).toBe(false);
  });

  it('resolves use super::* in mod tests to the enclosing file — no crate-root edge (Speedy 34-file case)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod reading;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod ovp;\n' },
      { path: 'src/reading/ovp.rs', content: 'pub fn anchor() {}\nmod tests {\n  use super::*;\n  #[test]\n  fn t() { anchor(); }\n}\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(unresolved).toEqual([]);
    // A glob re-export of the enclosing module is a SELF-import, so there is no edge at all, and there is never a false edge to the crate root `lib.rs`.
    expect(edges.filter((e) => e.fromFile === 'src/reading/ovp.rs')).toEqual([]);
    expect(edges.some((e) => e.toFile === 'src/lib.rs' && e.fromFile === 'src/reading/ovp.rs')).toBe(false);
  });

  it('bin+lib crate: crate key resolves to lib.rs, main.rs keeps its own crate:: imports working', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cells-libmain-'));
    const startCwd = process.cwd();
    try {
      mkdirSync(join(root, 'src', 'app'), { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '[package]\n');
      writeFileSync(join(root, 'src', 'lib.rs'), 'pub mod app;\npub struct RootItem;\n');
      writeFileSync(join(root, 'src', 'main.rs'), 'mod app;\nuse crate::app::App;\nfn main() {}\n');
      writeFileSync(join(root, 'src', 'app', 'mod.rs'), 'pub struct App;\nuse crate::RootItem;\n');
      process.chdir(root);
      // `main.rs` next to a `lib.rs` is NOT the canonical crate root.
      expect(fileToModule('src/main.rs')).toBe('crate::main');
      expect(fileToModule('src/lib.rs')).toBe('crate');
      const files: SourceFile[] = [
        { path: 'src/lib.rs', content: readFileSync(join(root, 'src/lib.rs'), 'utf8') },
        { path: 'src/main.rs', content: readFileSync(join(root, 'src/main.rs'), 'utf8') },
        { path: 'src/app/mod.rs', content: readFileSync(join(root, 'src/app/mod.rs'), 'utf8') },
      ];

      const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
      expect(unresolved).toEqual([]);
      // An import of a root item (`use crate::RootItem`) edges to `lib.rs`, and NOT to `main.rs`.
      expect(edges).toContainEqual({ fromFile: 'src/app/mod.rs', toFile: 'src/lib.rs', import: 'crate::RootItem', symbols: ['RootItem'] });
      // The `crate::` imports of `main.rs` still resolve through the shared module files.
      expect(edges).toContainEqual({ fromFile: 'src/main.rs', toFile: 'src/app/mod.rs', import: 'crate::app::App', symbols: ['App'] });
      expect(edges.some((e) => e.toFile === 'src/main.rs' && e.fromFile !== 'src/main.rs')).toBe(false);
    } finally {
      process.chdir(startCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rust bare-first-segment resolution (module-relative walk-up)', () => {
  it('pub use in a NESTED module re-exports locally — imports through it keep their edge (was silently dropped)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod app;\npub mod reading;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod tokenization;\npub use tokenization::tokenize_text;\n' },
      { path: 'src/reading/tokenization.rs', content: 'pub fn tokenize_text() {}\n' },
      { path: 'src/app/mod.rs', content: 'pub mod app_impl;\n' },
      { path: 'src/app/app_impl.rs', content: 'use crate::reading::tokenize_text;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    expect(unresolved).toEqual([]);
    // The re-export is LOCAL (`crate::reading::tokenization`), so the code does not drop the import as external. The import resolves through the re-exporting module, because the direct hit wins.
    expect(edges).toContainEqual({ fromFile: 'src/app/app_impl.rs', toFile: 'src/reading/mod.rs', import: 'crate::reading::tokenize_text', symbols: ['tokenize_text'] });
    // The re-export itself resolves relative to the module of its defining file.
    expect(edges).toContainEqual({ fromFile: 'src/reading/mod.rs', toFile: 'src/reading/tokenization.rs', import: 'tokenization::tokenize_text' }); // There are no symbols, because the bare-first-segment path computes no absolute path. This is the honest gap.
  });

  it('a bare use tokenization::foo in a nested file resolves module-relative (not null, not the crate root)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod reading;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod tokenization;\n' },
      { path: 'src/reading/tokenization.rs', content: 'pub fn tokenize_text() {}\n' },
      { path: 'src/reading/ovp.rs', content: 'use tokenization::tokenize_text;\npub fn anchor() { tokenize_text() }\n' },
    ];

    const { edges } = await rustImporter.extract({ codeDirs: ['src'], files });
    // The Rust 2018 rule: a bare first segment walks up from `crate::reading` to `crate::reading::tokenization`.
    expect(edges).toContainEqual({ fromFile: 'src/reading/ovp.rs', toFile: 'src/reading/tokenization.rs', import: 'tokenization::tokenize_text' });
    // There is never a false edge to the crate root.
    expect(edges.some((e) => e.toFile === 'src/lib.rs' && e.fromFile === 'src/reading/ovp.rs')).toBe(false);
  });

  it('a pub use of an external crate in a NESTED module stays external', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod ui;\n' },
      { path: 'src/ui.rs', content: 'pub use owo_colors;\n' },
      { path: 'src/app.rs', content: 'use crate::ui::owo_colors::OwoColorize;\n' },
    ];

    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files });
    // An import that routes through an external re-export gives no edge, and it is NOT flagged as broken local.
    expect(edges.filter((e) => e.import.includes('owo_colors'))).toEqual([]);
    expect(unresolved.filter((u) => u.import.includes('owo_colors'))).toEqual([]);
  });
});
