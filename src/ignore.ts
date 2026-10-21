import { minimatch } from 'minimatch';

/**
 * The `.cells/ignore` file.
 *
 * The file declares files that are intentionally free of cells, such as examples,
 * scripts, and scratch files. The syntax is the same as in a `.gitignore` file. The code
 * census (`listCodeFiles`) excludes these files. Therefore the files do not count as code
 * and do not appear as orphans.
 *
 * This module parses and matches only. The IO layer reads the file and applies the
 * patterns.
 */

/** Parse a `.cells/ignore` file. Each line holds one glob. Blank lines and lines that
 *  start with `#` are dropped. Pure. */
export function parseIgnore(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * Test whether `path` matches the ignore patterns. The patterns use gitignore-style globs
 * and support `**`.
 *
 * A pattern without a slash matches at any depth, because `matchBase` is on. A trailing `/`
 * marks a directory. Such a pattern matches the whole tree below that directory, as in
 * gitignore.
 *
 * Patterns evaluate from top to bottom and the last match wins. A pattern with a `!`
 * prefix includes again a path that an earlier pattern ignored.
 *
 * Limitation, the same as in gitignore: a file that is included again below an ignored
 * directory stays ignored. This code does not track parent directories.
 *
 * `dot: true` applies only to `**` patterns. Therefore `dir/**` traverses hidden
 * directories. A plain glob keeps the gitignore rule that `*` does not match a leading
 * dot.
 */
export function isIgnored(path: string, patterns: string[]): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const p = negate ? raw.slice(1) : raw;
    const pattern = p.endsWith('/') ? `**/${p}**` : p; // A directory pattern such as `dist/` becomes `**/dist/**` and matches at any depth. That is the gitignore rule for a directory.
    if (minimatch(path, pattern, { matchBase: true, dot: pattern.includes('**') })) ignored = !negate;
  }
  return ignored;
}
