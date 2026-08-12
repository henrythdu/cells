import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Crossing, type CrossingsDelta, deriveCrossings, diffCrossings } from './crossings.js';
import { collectImportEdges } from './importers.js';
import type { Ownership } from './ownership.js';

/**
 * The `crossings --diff` feature: how did cross-cell crossings change between the
 * working tree and git HEAD? A deep module — one interface (`crossingsDelta`) hides
 * the whole mechanism: HEAD extraction, re-collecting import edges there, re-deriving
 * crossings under the same ownership, and diffing. The git machinery is internal
 * (only this feature needs it); `io` stays pure state-read.
 */

// --- git: a throwaway copy of HEAD (internal — only --diff needs it) ---

/** Is the working tree inside a git repo? */
function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Extract the HEAD tree (tracked files only) into `dir`. False if there's no HEAD yet
 *  (fresh repo) or git/tar is unavailable. */
function extractHeadTree(dir: string): boolean {
  try {
    // No shell, no stdout buffer: git writes the archive to a file inside `dir`, tar
    // extracts from it. git's failure (no HEAD on a fresh repo) throws — not masked
    // by a pipe's last-command exit status — and file I/O avoids the default 1MB
    // maxBuffer on big repos (e.g. one bundling grammar WASMs). `dir` is a temp dir
    // removed by withHeadTree, so the archive file needs no separate cleanup.
    const archiveFile = join(dir, '.head-archive.tar');
    execFileSync('git', ['archive', '--output', archiveFile, 'HEAD'], { stdio: 'ignore' });
    execFileSync('tar', ['-x', '-f', archiveFile, '-C', dir], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run `fn` against a throwaway copy of the HEAD tree; always clean up.
 *  Returns null if HEAD can't be read (no commits / git broken). */
async function withHeadTree<T>(fn: (headDir: string) => Promise<T> | T): Promise<T | null> {
  const dir = mkdtempSync(join(tmpdir(), 'cells-head-'));
  try {
    if (!extractHeadTree(dir)) return null;
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the feature: working crossings vs HEAD ---

/** Derive the crossings delta (working tree vs HEAD): added/removed cross-cell edges.
 *  `working` is the working-tree crossings, derived once by the caller (the non-diff
 *  path needs them too — no double scan). The HEAD side is derived internally: extract
 *  HEAD into a temp dir, re-collect its import edges, map to crossings under the SAME
 *  ownership, diff. Returns null when git/HEAD is unavailable (not a repo, no commits,
 *  or the HEAD read threw) so the caller degrades to the current-crossings view. */
export async function crossingsDelta(working: Crossing[], ownership: Ownership): Promise<CrossingsDelta | null> {
  if (!isGitRepo()) return null;
  try {
    return await withHeadTree(async (headDir) => {
      const { edges: headEdges } = await collectImportEdges(headDir);
      return diffCrossings(working, deriveCrossings(headEdges, ownership));
    });
  } catch {
    return null; // HEAD derivation blew up (dep-cruiser panic, IO) — degrade gracefully.
  }
}

/**
 * Logical coupling: files that co-change with `files` in git history (same-commit
 * co-occurrence) — dependencies the import graph can't see. Top partners by count,
 * the shown cell's own files excluded. [] when not a git repo or no history. Source-
 * based (reads git history, never executes code) — the behavioral axis crossings lack.
 */
export function coChangePairs(files: string[]): { file: string; count: number }[] {
  if (files.length === 0 || !isGitRepo()) return [];
  // Step 1: the commits that touched these files (pathspec limits --name-only to the
  // matching files, so the full per-commit file lists must come from a second call).
  let hashes: string;
  try {
    hashes = execFileSync('git', ['log', '--format=%H', '--', ...files], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return []; // no HEAD yet / history unavailable
  }
  const hashList = hashes
    .split('\n')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hashList.length === 0) return [];
  // Step 2: each commit's FULL changed-file list (git show does not traverse ancestry).
  // --diff-merges=first-parent: git show defaults to a COMBINED diff for merge commits, which
  // omits cleanly-merged files — the first-parent view lists everything the merge brought in.
  // ponytail: hashList length is bounded by commits touching the cell's files; ~41 chars/hash,
  // ARG_MAX ~2MB → tens of thousands of hashes would overflow, caught below as [] (no co-changes).
  let out: string;
  try {
    out = execFileSync('git', ['show', '--name-only', '--diff-merges=first-parent', '--format=%H', ...hashList], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const owned = new Set(files);
  const counts = new Map<string, number>();
  // Per commit: `hash\n\nfile1\nfile2\n` — commits separated by a single \n, so split
  // on the hash that starts each record rather than on blank lines (which only separate
  // the hash from its own file list).
  const commitRe = /([0-9a-f]{40,64})\n\n([\s\S]*?)(?=\n[0-9a-f]{40,64}\n\n|$)/g;
  for (const m of out.matchAll(commitRe)) {
    const changed = m[2].split('\n').filter((f) => f.length > 0);
    if (!changed.some((f) => owned.has(f))) continue; // only commits touching the cell's files
    for (const f of changed) {
      if (!owned.has(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file, count }));
}
