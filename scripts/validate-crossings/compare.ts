/** Comparison pass: blind-zone removal, per-language granularity
 *  normalization, scoping, and the under/over-flag + false-unresolved diffs.
 *  Pure — takes sets in, returns the report rows. */

import { posix } from 'node:path';

export interface ParsedOracle {
  edges: Set<string>; // `${fromFile}\0${toFile}`
  resolvedSpecs?: Map<string, Set<string>>; // ts only: fromFile → resolved specifiers
  fromFiles?: Set<string>; // files the oracle indexed (for blind-zone detection)
}

export type Lang = 'ts' | 'rust' | 'go' | 'java' | 'cpp' | 'python';

/** Files the oracle never indexed (alternate-source trees like GWT's src-super,
 *  SDK-gated modules like guava's android/failureaccess) are oracle BLIND ZONES —
 *  cells' edges touching them can't be verified. Drop both sides' edges that touch
 *  blind files and report the count: honest, and it replaces per-repo hardcoding. */
function blindFiles(ours: Iterable<string>, oracleFromFiles: Set<string> | undefined): string[] {
  if (!oracleFromFiles) return [];
  return [...new Set([...ours].flatMap((k) => k.split('\0')))].filter((f) => !oracleFromFiles.has(f));
}

/** Go imports are package-level, but both sides pin them to a representative file —
 *  and they pick DIFFERENT representatives. Compare Go at package granularity
 *  (dirname of the target); the representative-file choice becomes irrelevant.
 *  Java: the mirror image — same-package classes need NO import statement, so
 *  scip-java's usage refs inside a package are not import edges; cross-package
 *  refs are impossible without an import. Drop same-dir oracle edges. */
export function normalize(set: Iterable<string>, lang: Lang): Set<string> {
  const out = new Set<string>();
  for (const k of set) {
    const [f, t] = k.split('\0');
    if (lang === 'go') {
      const tdir = posix.dirname(t);
      if (tdir !== posix.dirname(f)) out.add(`${f}\0${tdir}`); // same-dir = same package = not an import
    } else if (lang === 'java') {
      if (posix.dirname(f) !== posix.dirname(t)) out.add(k); // same-package use needs no import
    } else {
      out.add(k);
    }
  }
  return out;
}

const tsExt = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const langExt: Partial<Record<Lang, RegExp>> = {
  ts: tsExt,
  java: /\.(java|kt)$/,
  cpp: /\.(c|h|cc|cpp|cxx|hpp|hxx|hh|m|mm)$/,
  python: /\.py$/,
};

/** Scope the comparison to the audited language: our side keeps only edges
 *  FROM the language's files; the oracle side drops node_modules (type-dep
 *  internals the census never sees) and non-code targets (json/package.json —
 *  cells reports those as unresolved, the compiler resolves them as data
 *  imports). Oracle targets land on the package's BUILT types (dist/index.d.ts
 *  via node_modules exports) where cells resolves source — that divergence is a
 *  REPORTED over-flag, NOT something to map away: we validate our derivation,
 *  we don't force agreement. */
export function scoped(set: Iterable<string>, side: 'oracle' | 'ours', lang: Lang): Set<string> {
  const out = new Set<string>();
  for (const k of set) {
    const [f, t] = k.split('\0');
    if (f.startsWith('node_modules/') || t.startsWith('node_modules/')) continue;
    if (/(^|\/)dist\//.test(f) || /(^|\/)dist\//.test(t)) continue; // built output — the census skips dist
    if (/(^|\/)target\//.test(f) || /(^|\/)target\//.test(t)) continue; // maven build output (guava's GWT source copies)
    if (lang === 'ts') {
      if (side === 'oracle' && !tsExt.test(t)) continue;
      if (side === 'ours' && !tsExt.test(f)) continue;
    }
    if (langExt[lang] && side === 'ours' && !langExt[lang].test(f)) continue;
    out.add(k);
  }
  return out;
}

export interface Report {
  ourEdges: Set<string>;
  oracleEdges: Set<string>;
  blind: string[];
  oracleOnly: string[];
  oursOnly: string[];
  falseUnresolved: string[];
}

export function compare(
  ours: CellsLike,
  oracle: ParsedOracle,
  lang: Lang,
): Report {
  const blind = blindFiles(ours.edges, oracle.fromFiles);
  const notBlind = (k: string): boolean => {
    const [f, t] = k.split('\0');
    return !blind.includes(f) && !blind.includes(t);
  };
  const oracleEdges = new Set([...scoped(normalize(oracle.edges, lang), 'oracle', lang)].filter(notBlind));
  const ourEdges = new Set([...scoped(normalize(ours.edges, lang), 'ours', lang)].filter(notBlind));

  const oracleOnly = [...oracleEdges].filter((k) => !ourEdges.has(k));
  const oursOnly = [...ourEdges].filter((k) => !oracleEdges.has(k));

  // classification cross-check (ts only): a specifier cells left unresolved
  // that the compiler itself resolved
  const falseUnresolved: string[] = [];
  if (oracle.resolvedSpecs) {
    for (const [, u] of ours.unresolved) {
      const specs = oracle.resolvedSpecs.get(u.fromFile);
      if (specs?.has(u.import)) falseUnresolved.push(`${u.fromFile} imports "${u.import}"`);
    }
  }

  return { ourEdges, oracleEdges, blind, oracleOnly, oursOnly, falseUnresolved };
}

interface CellsLike {
  edges: Set<string>;
  unresolved: Map<string, { fromFile: string; import: string }>;
}
