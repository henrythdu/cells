/** cpp oracle — the include graph from the compiler itself. scip-clang was tried
 *  first — its refs are symbol USES (calls reach declarations through
 *  transitively-included headers), not imports. `-H` prints the include tree:
 *  depth-1 entries = the TU's DIRECT includes — exactly the import model.
 *  compile_commands.json comes from an out-of-tree cmake configure (repo stays
 *  pristine; extraArgs restricts the target set — llama.cpp defaults to every
 *  example/tool, hundreds of TUs). RAW = per-TU stderr, wrapped with the TU
 *  path; parsed on load. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedOracle } from '../compare.ts';
import type { Run, RunResult } from '../shared.ts';
import { rel } from '../shared.ts';

/** The compile argv for one TU, shell-free: prefer compile_commands `arguments` (cmake
 *  always emits it) minus the flags that would write output (-o and depfile -M*), with -c
 *  replaced by -fsyntax-only -H. Returns null when the entry has no arguments array — the
 *  caller falls back to the `command` string (a last resort; a repo-controlled string is
 *  only ever passed to a shell there, never for the arguments path). Pure. */
export function tuArgv(arguments_: string[] | undefined): string[] | null {
  if (!Array.isArray(arguments_) || arguments_.length === 0) return null;
  const out: string[] = [];
  for (let i = 0; i < arguments_.length; i++) {
    const a = arguments_[i];
    if (a === '-o' || a === '-MF' || a === '-MT' || a === '-MQ') {
      i++; // skip the flag's value
      continue;
    }
    if (a === '-M' || a === '-MD' || a === '-MMD' || a === '-MM' || a === '-c') continue;
    out.push(a);
  }
  out.push('-fsyntax-only', '-H');
  return out;
}

/** Swap the TU's source path for a header path in an argv (the header recompile pass).
 *  Exact match first, then a suffix match (compdb paths are usually absolute). Pure. */
export function withTuPath(argv: string[], src: string, header: string): string[] {
  const idx = argv.findIndex((a) => a === src || a.endsWith(`/${src}`) || a.endsWith(`\\${src}`));
  if (idx === -1) return argv;
  const out = [...argv];
  out[idx] = header;
  return out;
}

/** RAW cpp oracle: cmake configure → compdb → per-TU `-H` transcripts. */
export function oracleCppRaw(repo: string, runFn: Run, extraArgs: string[]): string {
  if (!existsSync(join(repo, 'CMakeLists.txt'))) throw new Error(`no CMakeLists.txt in ${repo} — compile_commands.json needs a cmake configure`);
  const tmp = mkdtempSync(join(tmpdir(), 'vc-cpp-'));
  try {
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
    const reachedHeaders = new Map<string, { argv: string[] | null; cmd: string; dir: string; src: string }>(); // in-repo header → first TU command that reached it
    const runTu = (argv: string[] | null, cmd: string, dir: string): RunResult => (argv ? runFn(argv[0], argv.slice(1), dir) : runFn('/bin/bash', ['-c', `${cmd} 2>&1`], dir)); // command-string fallback only — no arguments array in the compdb
    for (const entry of db) {
      if (!/^\S*\.(c|cc|cpp|cxx|m|mm)$/.test(entry.file)) continue; // headers are reached via includes, not compiled
      const argv = tuArgv(entry.arguments);
      const cmd = (entry.command ?? '')
        .replace(/\s+-o\s+\S+/g, '')
        .replace(/\s+-M(?:D|MD|F|T)(?:\s+\S+)?/g, '')
        .replace(/\s+-c(?=\s)/, ' -fsyntax-only -H ');
      const r = runTu(argv, cmd, entry.directory ?? repo);
      out.push(`# TU ${rel(repo, entry.file)} ${r.ok ? 'OK' : 'FAIL'}\n${r.stdout}`); // FAIL = disabled/dead targets (cmake lists them, the build never compiles them) — unverifiable, treated blind
      // Headers the build reached ARE importers in the cells model (attr.h → cast.h).
      // Recompile each with -H so their direct includes become oracle edges too.
      for (const m of r.stdout.matchAll(/^\.+ (\/\S+\.(?:h|hpp|hh|hxx))$/gm)) {
        const h = rel(repo, m[1]);
        if (!h.startsWith('..') && !reachedHeaders.has(h)) reachedHeaders.set(h, { argv, cmd, dir: entry.directory ?? repo, src: entry.file });
      }
    }
    for (const [h, { argv, cmd, dir, src }] of reachedHeaders) {
      // Header pass: same argv/command, the TU swapped for the header. The header lives in
      // the repo; the original -I flags are dir-relative, so the same dir applies.
      const args = argv ? withTuPath(argv, src, join(repo, h)) : null;
      const cmd2 = args ? '' : cmd.replace(/(?:^|\s)(\S+\.(?:c|cc|cpp|cxx|m|mm))(?:\s|$)/, (mm, s: string) => mm.replace(s, join(repo, h)));
      const r = runTu(args, cmd2, dir);
      out.push(`# TU ${h} ${r.ok ? 'OK' : 'FAIL'}\n${r.stdout}`);
    }
    return out.join('\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // the cmake build dir is a throwaway — never leave it behind
  }
}

/** Parse the wrapped per-TU -H transcripts into file→file edges. Direct includes are
 *  the depth-1 lines (exactly one leading '. '). Deeper dots = transitively-reached
 *  headers — not imports (cells' model: direct #include only), but they ARE oracle-
 *  visible files: a header reached at any depth was opened by the compiler, so it's
 *  not a blind zone (fromFiles = TUs + every in-repo path the compiler opened). */
export function oracleCppFromRaw(raw: string, repo: string): ParsedOracle {
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
