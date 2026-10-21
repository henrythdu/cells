/**
 * TOML output helpers that both domain serializers use: the cell serializer and the
 * ownership serializer. The helpers live here so the two serializers do not duplicate
 * them. This is a shared concern, not a private helper of one cell.
 */

/**
 * Quote one string for TOML output.
 *
 * The function escapes backslashes, double quotes, and control characters. TOML basic
 * strings do not permit raw newlines, tabs, or control bytes. Therefore a newline becomes
 * `\n`, a tab becomes `\t`, and another control character becomes `\uXXXX`. The value
 * keeps its exact form through smol-toml.
 *
 * A purpose or a signature can contain a newline. The function must not produce an
 * invalid `.cell.toml` file for such a value.
 */
export function tomlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Format a string array as an inline TOML array. */
export function tomlArray(arr: string[]): string {
  return `[${arr.map(tomlString).join(', ')}]`;
}
