import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderHelp } from '../src/help.js';

describe('README ↔ dispatch table (drift guard)', () => {
  // Text-scan, not import: help cell requires [] — importing cli.ts would be an
  // undeclared crossing. The README's command table is a hand-written second
  // copy of the dispatch table; this gate keeps the two in sync in both
  // directions (added command without a row / stale row after a removal).
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const names = [...cli.matchAll(/usage: 'cells ([a-z0-9-]+)/g)].map((m) => m[1]);

  it('README documents every dispatch-table command', () => {
    expect(names.length).toBeGreaterThan(20); // the table is the source of truth
    for (const name of names) {
      // \b: name must end at a boundary — `cells imports` must not match `cells imports2`
      const ok = new RegExp(`cells ${name}\\b`).test(readme) || new RegExp(`\`${name}\``).test(readme);
      expect(ok, `README missing cells ${name}`).toBe(true);
    }
  });

  it('every README row is a real command (no stale rows)', () => {
    const rows = [...readme.matchAll(/\| `cells ([a-z0-9-]+)/g)].map((m) => m[1]);
    const known = new Set([...names, 'help']); // help is a built-in outside the table (cli.ts:156)
    for (const name of rows) {
      expect(known.has(name), `stale README row cells ${name}`).toBe(true);
    }
  });
});

describe('renderHelp — the COMMANDS block derives from the dispatch table (drift guard)', () => {
  it('renders every command usage + desc, wrapped to 100 cols', () => {
    const rows = [
      { usage: 'cells payload <name>', desc: 'print a payload' },
      { usage: 'cells new <name> [--purpose "..."] [--requires a,b] [--layer N]', desc: 'scaffold a cell declaration' },
      { usage: 'cells x', desc: 'word '.repeat(60).trim() },
    ];
    const out = renderHelp(rows);
    for (const r of rows) {
      expect(out).toContain(r.usage.replace('cells ', '')); // command + flags present
    }
    expect(out).toContain('print a payload'); // short desc stays contiguous
    for (const w of 'word '.repeat(60).trim().split(' ')) {
      expect(out).toContain(w); // wrapped desc keeps every word (40-col continuation indent)
    }
    // only the RENDERED block is width-guaranteed (static prose above may exceed 100)
    const block = out.split('\n').slice(out.indexOf('COMMANDS'), out.indexOf('RULES'));
    for (const line of block) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
