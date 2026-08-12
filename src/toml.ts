/**
 * TOML emission primitives shared by the domain serializers (Cell, Ownership).
 * Kept here so the two codecs stay DRY — a cross-cutting concern, not one
 * cell's private helper.
 */

/** Quote a string for TOML — escape backslash, double-quote, and control characters
 *  (basic strings forbid raw newlines/tabs/control bytes; `\uXXXX` keeps the round-trip
 *  through smol-toml). A purpose or signature containing a newline must not produce an
 *  unparseable .cell.toml. */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** Format a string array as a TOML inline array. */
export function tomlArray(arr: string[]): string {
  return '[' + arr.map(tomlString).join(', ') + ']';
}
