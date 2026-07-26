import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { collectImportEdges } from './importers.js';
import { deriveCrossings, diffCrossings, type Crossing, type CrossingsDelta } from './crossings.js';
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
