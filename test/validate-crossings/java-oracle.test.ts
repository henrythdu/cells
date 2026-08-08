import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { edgesFromJava } from '../../scripts/validate-crossings/oracles/java.ts';

const doc = (path: string, symbols: string[]) => ({
  relative_path: path,
  occurrences: symbols.map((symbol) => ({ symbol, symbol_roles: 1 })),
});

describe('edgesFromJava — import statements × scip-java definition map', () => {
  let repo: string;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });
  const touch = (p: string, content: string): void => {
    const full = join(repo, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };

  it('resolves imports through the FQN→file map, walking prefixes for inner classes', () => {
    repo = mkdtempSync(join(tmpdir(), 'vc-java-'));
    touch('src/com/acme/Outer.java', 'package com.acme;\nclass Outer {}\n');
    touch('src/com/acme/Outer$Inner.java', 'package com.acme;\nclass Inner {}\n');
    touch('src/app/Main.java', 'package app;\nimport com.acme.Outer.Inner;\nclass Main {}\n');
    const index = {
      documents: [doc('src/com/acme/Outer.java', ['scip-java maven grp art com/acme/Outer#']), doc('src/app/Main.java', [])],
    };
    const out = edgesFromJava(index as never, repo);
    // Inner is defined in the outer class file — the prefix walk must land there
    expect([...out.edges]).toEqual(['src/app/Main.java\0src/com/acme/Outer.java']);
  });

  it('drops target/ docs (build output) and unresolvable imports silently', () => {
    repo = mkdtempSync(join(tmpdir(), 'vc-java-'));
    touch('src/a/Main.java', 'package a;\nimport com.missing.Thing;\nclass Main {}\n');
    const index = {
      documents: [doc('target/generated/x.java', ['scip-java maven grp art gen/X#']), doc('src/a/Main.java', [])],
    };
    const out = edgesFromJava(index as never, repo);
    expect(out.edges.size).toBe(0);
    expect([...out.fromFiles!]).toEqual(['src/a/Main.java']); // src still oracle-visible
  });

  it('skips static imports only when the member class resolves (no self-edges)', () => {
    repo = mkdtempSync(join(tmpdir(), 'vc-java-'));
    touch('src/util/Consts.java', 'package util;\nclass Consts {}\n');
    touch('src/a/Main.java', 'package a;\nimport static util.Consts.X;\nclass Main {}\n');
    const index = {
      documents: [doc('src/util/Consts.java', ['scip-java maven grp art util/Consts#']), doc('src/a/Main.java', [])],
    };
    const out = edgesFromJava(index as never, repo);
    expect([...out.edges]).toEqual(['src/a/Main.java\0src/util/Consts.java']); // member stripped, class resolved
  });
});
