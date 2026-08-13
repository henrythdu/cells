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

/** One commit's full changed-file list (the change-coupling input shape). */
export interface CommitFiles {
  hash: string;
  files: string[];
}

/**
 * The last `limit` commits touching any owned file, each with its FULL changed-file
 * list (not pathspec-limited — union/Jaccard math needs every file in the commit).
 * The change-coupling analysis (ADR 0002) builds on this; [] when not a git repo,
 * no history, or a git call blew up (shallow clone → min(limit, depth) commits).
 * Source-based (reads git history, never executes code) — the behavioral axis
 * crossings lack.
 */
export function recentCommitFiles(ownedFiles: string[], limit = 200): CommitFiles[] {
  if (ownedFiles.length === 0 || !isGitRepo()) return [];
  // Step 1: the commits that touched these files (pathspec limits the log to the
  // matching files — the full per-commit file lists come from a second call).
  let hashes: string;
  try {
    hashes = execFileSync('git', ['log', '-n', String(limit), '--format=%H', '--', ...ownedFiles], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
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
  // ponytail: limit bounds hashList (~41 chars/hash, 200 ≈ 8KB — ARG_MAX safe); the 64MB
  // maxBuffer bounds pathological commits; overflow → [] (no coupling signal, same as today).
  let out: string;
  try {
    out = execFileSync('git', ['show', '--name-only', '--diff-merges=first-parent', '--format=%H', ...hashList], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const commits: { hash: string; files: string[] }[] = [];
  // Per commit: `hash\n\nfile1\nfile2\n` — commits separated by a single \n, so split
  // on the hash that starts each record rather than on blank lines (which only separate
  // the hash from its own file list).
  const commitRe = /([0-9a-f]{40,64})\n\n([\s\S]*?)(?=\n[0-9a-f]{40,64}\n\n|$)/g;
  for (const m of out.matchAll(commitRe)) {
    const changed = m[2].split('\n').filter((f) => f.length > 0);
    if (changed.length > 0) commits.push({ hash: m[1], files: changed });
  }
  return commits;
}
