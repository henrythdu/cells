import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Crossing, type CrossingsDelta, deriveCrossings, diffCrossings } from './crossings.js';
import { collectImportEdges } from './importers.js';
import type { Ownership } from './ownership.js';

/**
 * The `crossings --diff` feature: how did the crossings between cells change between the
 * working tree and git HEAD?
 *
 * This is a deep module. One interface (`crossingsDelta`) hides the whole mechanism: it
 * extracts the HEAD tree, collects the import edges there again, derives the crossings
 * under the same ownership, and compares the two sets. The git machinery is internal,
 * because only this feature needs it. The `io` module stays a pure reader of state.
 */

// --- git: a throwaway copy of HEAD. Only --diff needs it. ---

/** Test whether the working tree is inside a git repository. */
function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the HEAD tree (tracked files only) into `dir`. The function returns false when
 * there is no HEAD yet (a new repository) or when git or tar is not available.
 */
function extractHeadTree(dir: string): boolean {
  try {
    // There is no shell and no stdout buffer. Git writes the archive to a file inside
    // `dir`, and tar extracts from that file.
    //
    // A failure of git (no HEAD in a new repository) throws. A pipe would hide the failure
    // behind the exit status of the last command.
    //
    // File input and output also avoid the default 1 MB maxBuffer on a large repository,
    // for example one that bundles grammar WASM files. `withHeadTree` removes `dir`, so the
    // archive file needs no separate cleanup.
    const archiveFile = join(dir, '.head-archive.tar');
    execFileSync('git', ['archive', '--output', archiveFile, 'HEAD'], { stdio: 'ignore' });
    execFileSync('tar', ['-x', '-f', archiveFile, '-C', dir], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` against a throwaway copy of the HEAD tree, and always remove the copy. The
 * function returns null when it cannot read HEAD: no commits or a broken git.
 */
async function withHeadTree<T>(fn: (headDir: string) => Promise<T> | T): Promise<T | null> {
  const dir = mkdtempSync(join(tmpdir(), 'cells-head-'));
  try {
    if (!extractHeadTree(dir)) return null;
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the feature: the working crossings against HEAD ---

/**
 * Derive the delta of the crossings: the cell edges that the working tree added and
 * removed against HEAD.
 *
 * `working` is the set of crossings in the working tree, which the caller derives once. The
 * non-diff path needs them too, so this avoids a second scan.
 *
 * The function derives the HEAD side internally: it extracts HEAD into a temporary
 * directory, collects the import edges there again, maps them to crossings under the SAME
 * ownership, and compares the two sets.
 *
 * The function returns null when git or HEAD is not available: not a repository, no
 * commits, or a failed HEAD read. The caller then shows the current crossings.
 */
export async function crossingsDelta(working: Crossing[], ownership: Ownership): Promise<CrossingsDelta | null> {
  if (!isGitRepo()) return null;
  try {
    return await withHeadTree(async (headDir) => {
      const { edges: headEdges } = await collectImportEdges(headDir);
      return diffCrossings(working, deriveCrossings(headEdges, ownership));
    });
  } catch {
    return null; // The HEAD derivation failed, for example a grammar load error or a file system race during the derivation. Degrade gracefully.
  }
}

/** The full list of changed files for one commit. This is the input shape of the change-coupling analysis. */
export interface CommitFiles {
  hash: string;
  files: string[];
}

/**
 * Return the last `limit` commits that touch an owned file. Each commit contains its FULL
 * list of changed files, and not only the files that match a path. The union and Jaccard
 * math needs every file in the commit.
 *
 * The change-coupling analysis (ADR 0002) uses this function. The function returns an empty
 * array when the directory is not a git repository, when there is no history, or when a git
 * call fails. A shallow clone gives min(limit, depth) commits.
 *
 * The function reads git history and never executes code. This is the behavioral axis that
 * crossings do not have.
 */
export function recentCommitFiles(ownedFiles: string[], limit = 200): CommitFiles[] {
  if (ownedFiles.length === 0 || !isGitRepo()) return [];
  // Step 1: find the commits that touch these files. The path limits the log to the
  // matching files. A second call gets the full file list of each commit.
  let hashes: string;
  try {
    hashes = execFileSync('git', ['log', '-n', String(limit), '--format=%H', '--', ...ownedFiles], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return []; // There is no HEAD yet, or the history is not available.
  }
  const hashList = hashes
    .split('\n')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hashList.length === 0) return [];
  // Step 2: get the FULL changed-file list of each commit. `git show` does not traverse the
  // ancestry.
  //
  // `--diff-merges=first-parent`: `git show` uses a combined diff for a merge commit by
  // default, and that diff omits files that merged without a conflict. The first-parent
  // view lists every file that the merge brought in.
  //
  // Deliberate bounds: `limit` caps `hashList` (about 41 characters for each hash, so 200
  // hashes are about 8 KB, which is safe for ARG_MAX). The 64 MB maxBuffer bounds a
  // pathological commit. On overflow, the function returns an empty array, which gives no
  // coupling signal, as before.
  let out: string;
  try {
    out = execFileSync('git', ['show', '--name-only', '--diff-merges=first-parent', '--format=%H', ...hashList], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const commits: { hash: string; files: string[] }[] = [];
  // For each commit the output is `hash\n\nfile1\nfile2\n`. A single \n separates the
  // commits, so split on the hash that starts each record and not on blank lines. A blank
  // line separates only the hash from the file list of that commit.
  const commitRe = /([0-9a-f]{40,64})\n\n([\s\S]*?)(?=\n[0-9a-f]{40,64}\n\n|$)/g;
  for (const m of out.matchAll(commitRe)) {
    const changed = m[2].split('\n').filter((f) => f.length > 0);
    if (changed.length > 0) commits.push({ hash: m[1], files: changed });
  }
  return commits;
}
