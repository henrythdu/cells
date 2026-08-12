/** Oracle + cells caches. Oracles are minutes on big repos; reruns must skip.
 *  Keyed on (repo fingerprint + tool versions), stored in ~/.cache. The oracle
 *  cache holds RAW artifacts (tsc traces / decoded SCIP) — extraction-logic
 *  changes re-parse them with current code and never re-run the compilers.
 *  The cells cache is edge-based — cells logic is versioned by src/dist mtimes. */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Run } from './shared.ts';
import { newestMtime } from './shared.ts';

const CACHE_DIR = join(process.env.HOME ?? mkdtempSync('cells-validate-'), '.cache', 'cells-validate');

/** Cheap repo-state fingerprint: git HEAD + source count + newest mtime. */
function fingerprint(repo: string, runFn: Run): string {
  let n = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.cells' || e.name === '.git' || e.name === 'dist') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(repo);
  const g = runFn('git', ['rev-parse', 'HEAD'], repo);
  return `${g.ok ? g.stdout.trim() : 'no-git'}:${n}:${Math.round(newestMtime(repo))}`;
}

/** cells-side fingerprint: the repo fingerprint + cells' own src/dist state —
 *  importer edits must invalidate the cells cache even when the version
 *  string is unchanged (dev loop: fix importer → re-audit). */
function cellsFingerprint(repo: string, srcRoot: string, runFn: Run): string {
  return `${fingerprint(repo, runFn)}:cells:${Math.round(Math.max(newestMtime(srcRoot), newestMtime(join(srcRoot, '..', 'dist'))))}`;
}

function cacheKey(repo: string, lang: string, kind: string, fp: string): string {
  // v7: cache FORMAT. The oracle cache holds RAW artifacts — extraction-logic
  // changes re-parse them with current code and never re-run the compilers.
  const h = createHash('sha1').update(`${repo}\0${lang}\0${kind}\0v7\0${fp}`).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${h}.json.gz`);
}

const write = (key: string, content: string | Buffer): void => {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${key}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, key);
  } catch {
    /* cache is a convenience — never fail the audit on it */
  }
};

export function makeCache(repo: string, lang: string, srcRoot: string, runFn: Run, noCache: boolean) {
  const loadRaw = (kind: string, toolVersion: string): unknown | undefined => {
    if (noCache) return undefined;
    try {
      const c = JSON.parse(gunzipSync(readFileSync(cacheKey(repo, lang, kind, fingerprint(repo, runFn)))).toString('utf8'));
      if (c.toolVersion === toolVersion) return c.payload;
    } catch {
      /* cold cache */
    }
    return undefined;
  };

  const saveRaw = (kind: string, toolVersion: string, payload: unknown): void => {
    write(cacheKey(repo, lang, kind, fingerprint(repo, runFn)), gzipSync(Buffer.from(JSON.stringify({ toolVersion, payload }))));
  };

  const loadCells = (toolVersion: string): unknown | undefined => {
    if (noCache) return undefined;
    try {
      const c = JSON.parse(readFileSync(cacheKey(repo, lang, 'cells', cellsFingerprint(repo, srcRoot, runFn)), 'utf8'));
      if (c.toolVersion === toolVersion) return c;
    } catch {
      /* cold cache */
    }
    return undefined;
  };

  const saveCells = (toolVersion: string, data: Record<string, unknown>): void => {
    write(cacheKey(repo, lang, 'cells', cellsFingerprint(repo, srcRoot, runFn)), JSON.stringify({ toolVersion, ...data }));
  };

  return { loadRaw, saveRaw, loadCells, saveCells };
}
