/**
 * TOML emission primitives shared by the domain serializers (Cell, Ownership).
 * Kept here so the two codecs stay DRY — a cross-cutting concern, not one
 * cell's private helper.
 */

/** Quote a string for TOML (escape backslash + double-quote). */
export function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Format a string array as a TOML inline array. */
export function tomlArray(arr: string[]): string {
  return '[' + arr.map(tomlString).join(', ') + ']';
}
