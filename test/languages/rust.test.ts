import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rustImporter, fileToModule, resolveImportPath } from '../../src/languages/rust.js';
import type { SourceFile } from '../../src/imports.js';
import type { Ownership } from '../../src/ownership.js';

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

  it('anchors crate:: to the TEST crate root for integration-test files (stress: uv-client tests)', async () => {
    // tests/it/ssl_certs.rs does `use crate::http_util::SelfSigned` — http_util is a module of
    // the TEST crate (tests/it.rs), not the lib. crate:: must anchor to the test root.
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod app;\n' },
      { path: 'src/app.rs', content: 'pub struct LibOnly;\n' },
      { path: 'tests/it.rs', content: 'mod ssl_certs;\nmod http_util;\n' },
      { path: 'tests/it/ssl_certs.rs', content: 'use crate::http_util::SelfSigned;\n' },
      { path: 'tests/it/http_util.rs', content: 'pub struct SelfSigned;\n' },
    ];
    const ownership: Ownership = { lib: ['src/lib.rs', 'src/app.rs'], it: ['tests/it.rs', 'tests/it/ssl_certs.rs', 'tests/it/http_util.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['.'], files, ownership });
    const viaTestRoot = edges.find((e) => e.import === 'crate::http_util::SelfSigned');
    expect(viaTestRoot).toBeDefined();
    expect(viaTestRoot!.toFile).toBe('tests/it/http_util.rs'); // the TEST crate's module, not the lib's
    expect(unresolved).toHaveLength(0);
  });

  it('resolves enum-variant / deep item chains to the deepest real module (stress #5)', () => {
    // crate::token::TokenKind::Wildcard — TokenKind is an enum in module crate::token;
    // the variant lives in the module's file. Two drops, not one.
    expect(resolveImportPath('crate::reading::tokenization::Token::Kind', 'crate::app', m2f)).toBe('src/reading/tokenization.rs');
    // a missing mid-chain module under a real module resolves to the deepest real module
    // (same shape as an enum-variant path — indistinguishable without type info)
    expect(resolveImportPath('crate::reading::missing::Thing', 'crate::app', m2f)).toBe('src/reading/mod.rs');
    // never falls back to the crate root: no intermediate module at all → stays null
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

  it('resolves super:: chains inside inline mod blocks (wave-3 #1: headroom mod tests)', async () => {
    const files: SourceFile[] = [
      { path: 'src/compaction/compactor.rs', content: 'mod tests {\n  use super::super::ir::OpaqueKind;\n}\nuse super::ir::SimpleKind;\n' },
      { path: 'src/compaction/ir.rs', content: 'pub struct OpaqueKind;\npub struct SimpleKind;\n' },
      { path: 'src/ir.rs', content: 'pub struct OpaqueKind;\n' },
    ];
    const ownership: Ownership = { a: ['src/compaction/compactor.rs'], b: ['src/compaction/ir.rs'], c: ['src/ir.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    const superSuper = edges.find((e) => e.import === 'super::super::ir::OpaqueKind');
    expect(superSuper).toBeDefined();
    expect(superSuper!.toFile).toBe('src/compaction/ir.rs'); // mod-tests depth counts — NOT src/ir.rs
    expect(unresolved).toHaveLength(0);
  });

  it('silences re-exports of EXTERNAL crates — no false unresolved (stress #7: uv owo_colors)', async () => {
    // uv-warnings does `pub use owo_colors;` — the re-export leaves the partition; imports
    // routing through it (uv_warnings::owo_colors::OwoColorize) are real code but no owned
    // file exists to draw an edge to — they must NOT flag as broken local.
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod warnings;\npub mod ui;\n' },
      { path: 'src/warnings.rs', content: 'pub use owo_colors;\n' },
      { path: 'src/ui.rs', content: 'use crate::warnings::owo_colors::OwoColorize;\nuse crate::nope::Thing;\n' },
    ];
    const ownership: Ownership = { a: ['src/lib.rs', 'src/warnings.rs', 'src/ui.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    // the external re-export routes through nothing owned — no edge, no unresolved
    expect(edges.find((e) => e.import === 'crate::warnings::owo_colors::OwoColorize')).toBeUndefined();
    // a genuinely broken local import (no intermediate module at all) in the same file still flags
    expect(unresolved.map((u) => u.import)).toContain('crate::nope::Thing');
    expect(unresolved.filter((u) => u.import.includes('owo_colors'))).toHaveLength(0);
  });

  it('resolves pub use re-export chains (wave-3 #2: uv_audit::osv::Filter)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod service;\npub use service::osv;\n' },
      { path: 'src/service.rs', content: 'pub mod osv;\n' },
      { path: 'src/service/osv.rs', content: 'pub struct Filter;\n' },
      { path: 'src/other.rs', content: 'use crate::osv::Filter;\nuse crate::service::osv::Filter as Direct;\n' },
    ];
    const ownership: Ownership = { a: ['src/lib.rs', 'src/service.rs', 'src/service/osv.rs'], b: ['src/other.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    const viaAlias = edges.find((e) => e.import === 'crate::osv::Filter');
    expect(viaAlias).toBeDefined();
    expect(viaAlias!.toFile).toBe('src/service/osv.rs');
    expect(unresolved).toHaveLength(0);
  });

  it('honors explicit `as` aliases inside use groups + pub(crate) (ocr on wave-3 re-exports)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod svc;\npub(crate) use svc::{osv as oz, filter};\n' },
      { path: 'src/svc.rs', content: 'pub mod osv;\npub mod filter;\n' },
      { path: 'src/svc/osv.rs', content: 'pub struct Filter;\n' },
      { path: 'src/svc/filter.rs', content: 'pub struct F;\n' },
      { path: 'src/other.rs', content: 'use crate::oz::Filter;\nuse crate::svc::osv::Filter as Direct;\n' },
    ];
    const ownership: Ownership = { a: ['src/lib.rs', 'src/svc.rs', 'src/svc/osv.rs', 'src/svc/filter.rs'], b: ['src/other.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    // use crate::oz::Filter resolves through the ALIASED re-export (explicit `as oz` beats last-segment 'osv')
    const viaAlias = edges.find((e) => e.import === 'crate::oz::Filter');
    expect(viaAlias).toBeDefined();
    expect(viaAlias!.toFile).toBe('src/svc/osv.rs');
    // no false edge under the ORIGINAL name: crate::osv was renamed to oz
    expect(edges.some((e) => e.import === 'crate::osv::Filter')).toBe(false);
    // pub(crate) counts as public for crate-internal resolution
    expect(unresolved).toHaveLength(0);
  });

  it('does not hijack module references via item aliases (uv: pub use wheel::metadata fn)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'mod metadata;\nmod wheel;\npub use wheel::metadata;\nuse crate::metadata::ValidationError;\n' },
      { path: 'src/metadata.rs', content: 'pub struct ValidationError;\n' },
      { path: 'src/wheel.rs', content: 'pub fn metadata() {}\n' },
    ];
    const ownership: Ownership = { a: files.map((f) => f.path) };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    const direct = edges.find((e) => e.import === 'crate::metadata::ValidationError');
    expect(direct).toBeDefined();
    expect(direct!.toFile).toBe('src/metadata.rs'); // NOT hijacked to wheel.rs by the item alias
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

  it('cross-crate workspace imports resolve to the sibling crate (wave-1 stress bug)', async () => {
    // `use headroom_core::…` from headroom-cli: the crate NAME (not the dir path) must
    // resolve to the sibling's file — previously silently dropped as "external".
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
        ownership: {
          core: ['crates/headroom-core/src/lib.rs', 'crates/headroom-core/src/signals/mod.rs', 'crates/headroom-core/src/signals/plan.rs'],
          cli: ['crates/headroom-cli/src/main.rs'],
        },
      });
      // cross-crate import resolves to the sibling's file
      expect(edges).toContainEqual({ fromFile: 'crates/headroom-cli/src/main.rs', toFile: 'crates/headroom-core/src/signals/plan.rs', import: 'headroom_core::signals::plan::Plan' });
      // a broken mid-chain path (stress #5: `Mod::Enum::Variant` item chains) resolves to the
      // deepest real module — `signals` exists, `missing` doesn't (same shape as an enum
      // variant path; no source-based way to tell a missing module from an item without type
      // info). The edge lands on the nearest real module so the agent can inspect, and the
      // bare-root false edge is impossible (min 2 segments).
      expect(edges).toContainEqual({ fromFile: 'crates/headroom-cli/src/main.rs', toFile: 'crates/headroom-core/src/signals/mod.rs', import: 'headroom_core::signals::missing::Nope' });
      // a broken OWN-crate 2-segment import (no intermediate module at all) stays unresolved —
      // honest (never falls back to the importer's own crate root)
      expect(unresolved).toContainEqual({ fromFile: 'crates/headroom-cli/src/main.rs', import: 'crate::missing::Thing' });
      // serde stays silently-external (never unresolved)
      expect(unresolved).not.toContainEqual(expect.objectContaining({ import: 'serde_json::Value' }));
      // …and the broken mid-chain import is NOT in the unresolved list anymore
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
    const ownership: Ownership = { root: ['src/lib.rs'], foo: ['src/foo/mod.rs', 'src/foo/a.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    expect(unresolved).toEqual([]);
    // the brace form must resolve like the dotted form: super = crate::foo → foo/mod.rs,
    // NOT fall through to the crate root (lib.rs)
    expect(edges).toContainEqual({ fromFile: 'src/foo/a.rs', toFile: 'src/foo/mod.rs', import: 'super::LoadError' });
    expect(edges.some((e) => e.toFile === 'src/lib.rs' && e.fromFile === 'src/foo/a.rs')).toBe(false);
  });

  it('resolves use super::* in mod tests to the enclosing file — no crate-root edge (Speedy 34-file case)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod reading;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod ovp;\n' },
      { path: 'src/reading/ovp.rs', content: 'pub fn anchor() {}\nmod tests {\n  use super::*;\n  #[test]\n  fn t() { anchor(); }\n}\n' },
    ];
    const ownership: Ownership = { root: ['src/lib.rs'], reading: ['src/reading/mod.rs', 'src/reading/ovp.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    expect(unresolved).toEqual([]);
    // glob re-export of the enclosing module is a SELF-import — no edge at all (and never a
    // false crate-root edge to lib.rs)
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
      // main.rs next to a lib.rs is NOT the canonical crate root
      expect(fileToModule('src/main.rs')).toBe('crate::main');
      expect(fileToModule('src/lib.rs')).toBe('crate');
      const files: SourceFile[] = [
        { path: 'src/lib.rs', content: readFileSync(join(root, 'src/lib.rs'), 'utf8') },
        { path: 'src/main.rs', content: readFileSync(join(root, 'src/main.rs'), 'utf8') },
        { path: 'src/app/mod.rs', content: readFileSync(join(root, 'src/app/mod.rs'), 'utf8') },
      ];
      const ownership: Ownership = { root: ['src/lib.rs'], bin: ['src/main.rs'], app: ['src/app/mod.rs'] };
      const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
      expect(unresolved).toEqual([]);
      // root-item import (use crate::RootItem) edges to lib.rs, NOT main.rs
      expect(edges).toContainEqual({ fromFile: 'src/app/mod.rs', toFile: 'src/lib.rs', import: 'crate::RootItem' });
      // main.rs's own crate:: imports still resolve through the shared module files
      expect(edges).toContainEqual({ fromFile: 'src/main.rs', toFile: 'src/app/mod.rs', import: 'crate::app::App' });
      expect(edges.some((e) => e.toFile === 'src/main.rs' && e.fromFile !== 'src/main.rs')).toBe(false);
    } finally {
      process.chdir(startCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rust bare-first-segment resolution (module-relative, Speedy bug 4)', () => {
  it('pub use in a NESTED module re-exports locally — imports through it keep their edge (was silently dropped)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod app;\npub mod reading;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod tokenization;\npub use tokenization::tokenize_text;\n' },
      { path: 'src/reading/tokenization.rs', content: 'pub fn tokenize_text() {}\n' },
      { path: 'src/app/mod.rs', content: 'pub mod app_impl;\n' },
      { path: 'src/app/app_impl.rs', content: 'use crate::reading::tokenize_text;\n' },
    ];
    const ownership: Ownership = { root: ['src/lib.rs'], reading: ['src/reading/mod.rs', 'src/reading/tokenization.rs'], app: ['src/app/mod.rs', 'src/app/app_impl.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    expect(unresolved).toEqual([]);
    // the re-export is LOCAL (crate::reading::tokenization), so the import is not dropped
    // as external — it resolves through the re-exporting module (the direct hit wins)
    expect(edges).toContainEqual({ fromFile: 'src/app/app_impl.rs', toFile: 'src/reading/mod.rs', import: 'crate::reading::tokenize_text' });
    // the re-export itself resolves module-relative to its defining file
    expect(edges).toContainEqual({ fromFile: 'src/reading/mod.rs', toFile: 'src/reading/tokenization.rs', import: 'tokenization::tokenize_text' });
  });

  it('a bare use tokenization::foo in a nested file resolves module-relative (not null, not the crate root)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod reading;\n' },
      { path: 'src/reading/mod.rs', content: 'pub mod tokenization;\n' },
      { path: 'src/reading/tokenization.rs', content: 'pub fn tokenize_text() {}\n' },
      { path: 'src/reading/ovp.rs', content: 'use tokenization::tokenize_text;\npub fn anchor() { tokenize_text() }\n' },
    ];
    const ownership: Ownership = { root: ['src/lib.rs'], reading: ['src/reading/mod.rs', 'src/reading/tokenization.rs', 'src/reading/ovp.rs'] };
    const { edges } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    // Rust 2018: bare first segment walks up from crate::reading → crate::reading::tokenization
    expect(edges).toContainEqual({ fromFile: 'src/reading/ovp.rs', toFile: 'src/reading/tokenization.rs', import: 'tokenization::tokenize_text' });
    // never a false crate-root edge
    expect(edges.some((e) => e.toFile === 'src/lib.rs' && e.fromFile === 'src/reading/ovp.rs')).toBe(false);
  });

  it('a pub use of an external crate in a NESTED module stays external (stress #7 still holds)', async () => {
    const files: SourceFile[] = [
      { path: 'src/lib.rs', content: 'pub mod ui;\n' },
      { path: 'src/ui.rs', content: 'pub use owo_colors;\n' },
      { path: 'src/app.rs', content: 'use crate::ui::owo_colors::OwoColorize;\n' },
    ];
    const ownership: Ownership = { root: ['src/lib.rs', 'src/ui.rs', 'src/app.rs'] };
    const { edges, unresolved } = await rustImporter.extract({ codeDirs: ['src'], files, ownership });
    // external re-export routed import: no edge, and NOT flagged as broken local
    expect(edges.filter((e) => e.import.includes('owo_colors'))).toEqual([]);
    expect(unresolved.filter((u) => u.import.includes('owo_colors'))).toEqual([]);
  });
});
