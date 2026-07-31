import { minimatch } from 'minimatch';

/**
 * `.cells/ignore` — declare files that are intentionally cell-free
 * (examples, scripts, scratch), gitignore-style. Such files are excluded from
 * the code census (listCodeFiles), so they neither count nor surface as
 * "orphans". Pure parse + match; the IO layer reads the file and applies it.
 */

/** Parse a .cells/ignore file: one glob per line; drop blanks and `#` comments. Pure. */
export function parseIgnore(content: string): string[] {
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Does `path` match any ignore pattern (gitignore-style globs, `**` supported; basename
 *  patterns match at any depth via matchBase; a trailing `/` marks a directory → matches
 *  the whole tree under it, like gitignore's `dir/`)? Pure.
 *  dot:true applies only to `**` patterns — `dir/**` traverses hidden dirs (gitignore
 *  parity), while plain globs keep gitignore's rule that `*` doesn't match a leading dot. */
export function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const pattern = p.endsWith('/') ? `**/${p}**` : p; // `dist/` → `**/dist/**` — gitignore dir semantics, any depth
    return minimatch(path, pattern, { matchBase: true, dot: pattern.includes('**') });
  });
}
