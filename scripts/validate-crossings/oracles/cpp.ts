/** cpp oracle — the include graph from the compiler itself. scip-clang was tried
 *  first — its refs are symbol USES (calls reach declarations through
 *  transitively-included headers), not imports. `-H` prints the include tree:
 *  depth-1 entries = the TU's DIRECT includes — exactly the import model.
 *  compile_commands.json comes from an out-of-tree cmake configure (repo stays
 *  pristine; extraArgs restricts the target set — llama.cpp defaults to every
 *  example/tool, hundreds of TUs). RAW = per-TU stderr, wrapped with the TU
 *  path; parsed on load. */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../shared.ts';
import { rel } from '../shared.ts';

/** RAW cpp oracle: cmake configure → compdb → per-TU `-H` transcripts. */
export function oracleCppRaw(repo: string, runFn: Run, extraArgs: string[]): string {
  if (!existsSync(join(repo, 'CMakeLists.txt'))) throw new Error(`no CMakeLists.txt in ${repo} — compile_commands.json needs a cmake configure`);
  const tmp = mkdtempSync(join(tmpdir(), 'vc-cpp-'));
  const build = join(tmp, 'build');
  const cfg = runFn('cmake', ['-B', build, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', ...extraArgs, repo], repo);
  if (!cfg.ok) throw new Error(`cmake configure failed: ${(cfg.stderr || cfg.stdout).slice(0, 600)}`);
  let db: { file: string; command?: string; arguments?: string[]; directory?: string }[];
  try {
    db = JSON.parse(readFileSync(join(build, 'compile_commands.json'), 'utf8'));
  } catch {
    throw new Error('compile_commands.json missing or corrupt after cmake configure');
  }
  const out: string[] = [];
  const reachedHeaders = new Map<string, { cmd: string; dir: string }>(); // in-repo header → first TU command that reached it
  for (const entry of db) {
    if (!/^\S*\.(c|cc|cpp|cxx|m|mm)$/.test(entry.file)) continue; // headers are reached via includes, not compiled
    const cmd = (entry.command ?? entry.arguments?.join(' ') ?? '')
      .replace(/\s+-o\s+\S+/g, '') // drop -o (would name an output — with -fsyntax-only none is written, but -MD would name a .d)
      .replace(/\s+-M(?:D|MD|F|T)(?:\s+\S+)?/g, '') // depfile flags only — NOT -D defines (macros affect includes)
      .replace(/\s+-c(?=\s)/, ' -fsyntax-only -H ');
    const r = runFn('/bin/bash', ['-c', `${cmd} 2>&1`], entry.directory ?? repo); // compdb -I flags are relative to the entry's directory (the build dir)
    out.push(`# TU ${rel(repo, entry.file)} ${r.ok ? 'OK' : 'FAIL'}\n${r.stdout}`); // FAIL = disabled/dead targets (cmake lists them, the build never compiles them) — unverifiable, treated blind
    // Headers the build reached ARE importers in the cells model (attr.h → cast.h).
    // Recompile each with -H so their direct includes become oracle edges too.
    for (const m of r.stdout.matchAll(/^\.+ (\/\S+\.(?:h|hpp|hh|hxx))$/gm)) {
      const h = rel(repo, m[1]);
      if (!h.startsWith('..') && !reachedHeaders.has(h)) reachedHeaders.set(h, { cmd, dir: entry.directory ?? repo });
    }
  }
  for (const [h, { cmd, dir }] of reachedHeaders) {
    const hc = cmd
      .replace(/\s+-fsyntax-only -H /, ' -fsyntax-only -H ') // keep flags, swap the TU for the header
      .replace(/(?:^|\s)(\S+\.(?:c|cc|cpp|cxx|m|mm))(?:\s|$)/, (mm, src: string) => mm.replace(src, join(repo, h)));
    const r = runFn('/bin/bash', ['-c', `${hc} 2>&1`], dir); // same dir as the TU that reached it — its -I flags are dir-relative
    out.push(`# TU ${h} ${r.ok ? 'OK' : 'FAIL'}\n${r.stdout}`);
  }
  return out.join('\n');
}

export interface CppEdges {
  edges: Set<string>;
  fromFiles: Set<string>;
}

/** Parse the wrapped per-TU -H transcripts into file→file edges. Direct includes are
 *  the depth-1 lines (exactly one leading '. '). Deeper dots = transitively-reached
 *  headers — not imports (cells' model: direct #include only), but they ARE oracle-
 *  visible files: a header reached at any depth was opened by the compiler, so it's
 *  not a blind zone (fromFiles = TUs + every in-repo path the compiler opened). */
export function oracleCppFromRaw(raw: string, repo: string): CppEdges {
  const edges = new Set<string>();
  const fromFiles = new Set<string>();
  let cur: string | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^# TU (.+?) (OK|FAIL)$/);
    if (m) {
      // Failed compiles = dead/disabled targets (cmake lists every target in the compdb,
      // the build never compiles the disabled ones) — their imports are unverifiable, so
      // the section is blind. Out-of-repo TUs (cmake-generated files in the build dir)
      // aren't importers either.
      const h = m[1];
      cur = m[2] === 'OK' && !h.startsWith('..') ? h : null;
      if (cur) fromFiles.add(cur);
      continue;
    }
    if (cur && /^\.+ /.test(line)) {
      const to = rel(repo, line.replace(/^\.+ /, ''));
      if (to.startsWith('..') || to === cur) continue;
      fromFiles.add(to); // any in-repo file the compiler opened is oracle-visible
      if (/^\. [^.]/.test(line)) edges.add(`${cur}\0${to}`); // depth-1 = direct include
    }
  }
  return { edges, fromFiles };
}
