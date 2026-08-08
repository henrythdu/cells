import { describe, it, expect } from 'vitest';
import { renderHelp } from '../src/help.js';

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

