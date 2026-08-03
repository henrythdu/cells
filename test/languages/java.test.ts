import { describe, it, expect } from 'vitest';
import type { SourceFile } from '../../src/imports.js';
import { javaImporter } from '../../src/languages/java.js';

/** In-memory fixture — the java importer resolves against the census (ctx.files), no FS. */
function files(entries: Record<string, string>): SourceFile[] {
  return Object.entries(entries).map(([path, content]) => ({ path, content }));
}

async function extract(entries: Record<string, string>) {
  return javaImporter.extract({ files: files(entries), codeDirs: ['.'], ownership: {}, moduleRoot: '.', baseDir: '.' });
}

describe('java: module identity (package decl + basename)', () => {
  it('keys files by package + class name (content-derived, layout-agnostic)', async () => {
    const { edges, unresolved } = await extract({
      'com/acme/util/Util.java': 'package com.acme.util;\npublic class Util {}\n',
      'com/acme/core/Service.java': 'package com.acme.core;\nimport com.acme.util.Util;\npublic class Service {}\n',
    });
    expect(edges.find((e) => e.import === 'com.acme.util.Util')?.toFile).toBe('com/acme/util/Util.java');
    expect(unresolved).toEqual([]);
  });

  it('no package decl → not importable (default-package classes cannot be imported)', async () => {
    const { edges, unresolved } = await extract({
      'Util.java': 'public class Util {}\n',
      'com/acme/core/Service.java': 'package com.acme.core;\nimport Util;\npublic class Service {}\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([]); // single-segment import — no package, nothing owns it → external
  });
});

describe('java: resolution', () => {
  it('resolves inner-class imports to the outer class file (minus last segment)', async () => {
    const { edges, unresolved } = await extract({
      'com/acme/core/Outer.java': 'package com.acme.core;\npublic class Outer { public static class Inner {} }\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport com.acme.core.Outer.Inner;\npublic class Main {}\n',
    });
    expect(edges.find((e) => e.import === 'com.acme.core.Outer.Inner')?.toFile).toBe('com/acme/core/Outer.java');
    expect(unresolved).toEqual([]);
  });

  it('resolves static imports to the class file (member stripped)', async () => {
    const { edges, unresolved } = await extract({
      'com/acme/util/Helper.java': 'package com.acme.util;\npublic class Helper { public static String escape(String s) { return s; } }\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport static com.acme.util.Helper.escape;\npublic class Main {}\n',
    });
    expect(edges.find((e) => e.import === 'com.acme.util.Helper.escape')?.toFile).toBe('com/acme/util/Helper.java');
    expect(unresolved).toEqual([]);
  });

  it('does not draw a self-edge for an import of the file itself', async () => {
    const { edges } = await extract({
      'com/acme/util/Util.java': 'package com.acme.util;\nimport com.acme.util.Util;\npublic class Util {}\n',
    });
    expect(edges).toEqual([]);
  });
});

describe('java: wildcard imports (package-level → one representative edge)', () => {
  it('owned package → one edge to the shortest-named file of that package (alpha tiebreak)', async () => {
    const { edges, unresolved } = await extract({
      'com/acme/util/Helper.java': 'package com.acme.util;\npublic class Helper {}\n',
      'com/acme/util/Util.java': 'package com.acme.util;\npublic class Util {}\n',
      'com/acme/util/Aardvark.java': 'package com.acme.util;\npublic class Aardvark {}\n',
      'com/acme/util/Zebra.java': 'package com.acme.util;\npublic class Zebra {}\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport com.acme.util.*;\npublic class Main {}\n',
    });
    expect(edges).toEqual([{ fromFile: 'com/acme/app/Main.java', toFile: 'com/acme/util/Util.java', import: 'com.acme.util.*' }]); // Util (4) < Helper (6); Aardvark/Zebra tie → alpha
    expect(unresolved).toEqual([]);
  });

  it('external wildcard (java.util.*) → no edge, never flagged', async () => {
    const { edges, unresolved } = await extract({
      'com/acme/app/Main.java': 'package com.acme.app;\nimport java.util.*;\nimport java.util.List;\npublic class Main {}\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});

describe('java: unresolved classification (importer-package rule)', () => {
  it("missing sibling class in the importer's OWN package → flagged (same-package import = unambiguously own-code)", async () => {
    const { edges, unresolved } = await extract({
      'com/acme/core/Service.java': 'package com.acme.core;\npublic class Service {}\n',
      'com/acme/core/Main.java': 'package com.acme.core;\nimport com.acme.core.Servce;\npublic class Main {}\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([{ fromFile: 'com/acme/core/Main.java', import: 'com.acme.core.Servce' }]);
  });

  it("nested missing class in the importer's OWN package → flagged (generated class shape: retrofit PhoneProtos.Phone)", async () => {
    const { unresolved } = await extract({
      'retrofit2/converter/protobuf/ProtoConverterFactory.java': 'package retrofit2.converter.protobuf;\npublic class ProtoConverterFactory {}\n',
      'retrofit2/converter/protobuf/Test.java': 'package retrofit2.converter.protobuf;\nimport retrofit2.converter.protobuf.PhoneProtos.Phone;\npublic class Test {}\n',
    });
    expect(unresolved).toHaveLength(1);
  });

  it('cross-package miss in an owned package → silent (indistinguishable from a sibling-project lib; guava/Truth)', async () => {
    const { unresolved } = await extract({
      'com/acme/core/Service.java': 'package com.acme.core;\npublic class Service {}\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport com.acme.core.Servce;\npublic class Main {}\n',
    });
    expect(unresolved).toEqual([]);
  });

  it('sub-package of an owned package → silent (same shape as an external lib under the repo namespace)', async () => {
    const { unresolved } = await extract({
      'com/acme/core/Service.java': 'package com.acme.core;\npublic class Service {}\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport com.acme.core.missing.Missing;\npublic class Main {}\n',
    });
    expect(unresolved).toEqual([]);
  });

  it('nested import of a MISSING class in an owned package → flagged (retrofit: generated PhoneProtos.Phone)', async () => {
    const { edges, unresolved } = await extract({
      'retrofit-converters/protobuf/src/main/java/retrofit2/converter/protobuf/ProtoConverterFactory.java': 'package retrofit2.converter.protobuf;\npublic class ProtoConverterFactory {}\n',
      'retrofit-converters/protobuf/src/test/java/retrofit2/converter/protobuf/Test.java': 'package retrofit2.converter.protobuf;\nimport retrofit2.converter.protobuf.PhoneProtos.Phone;\npublic class Test {}\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([{ fromFile: 'retrofit-converters/protobuf/src/test/java/retrofit2/converter/protobuf/Test.java', import: 'retrofit2.converter.protobuf.PhoneProtos.Phone' }]);
  });

  it('external lib under an OWNED namespace → silent (guava owns com.google.common, Truth is external)', async () => {
    const { unresolved } = await extract({
      'com/google/common/Dummy.java': 'package com.google.common;\npublic class Dummy {}\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport com.google.common.truth.Truth;\nimport static com.google.common.truth.Truth.assertWithMessage;\npublic class Main {}\n',
    });
    expect(unresolved).toEqual([]);
  });

  it('nested static member of an OWNED class → resolves through progressive stripping', async () => {
    const { edges, unresolved } = await extract({
      'com/google/common/collect/testing/SampleElements.java': 'package com.google.common.collect.testing;\npublic class SampleElements { public static class Strings {} }\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport static com.google.common.collect.testing.SampleElements.Strings.AFTER_LAST;\npublic class Main {}\n',
    });
    expect(edges.find((e) => e.import === 'com.google.common.collect.testing.SampleElements.Strings.AFTER_LAST')?.toFile).toBe('com/google/common/collect/testing/SampleElements.java');
    expect(unresolved).toEqual([]);
  });

  it('external lib sharing a first segment with an owned package → silent (org.acme owned, org.junit external)', async () => {
    const { edges, unresolved } = await extract({
      'org/acme/core/Service.java': 'package org.acme.core;\npublic class Service {}\n',
      'com/acme/app/Main.java': 'package com.acme.app;\nimport org.junit.Test;\nimport com.google.common.collect.ImmutableList;\npublic class Main {}\n',
    });
    expect(edges).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('JDK imports → silent without a hardcoded list (java. is never owned)', async () => {
    const { unresolved } = await extract({
      'com/acme/app/Main.java': 'package com.acme.app;\nimport java.util.List;\nimport javax.swing.JFrame;\npublic class Main {}\n',
    });
    expect(unresolved).toEqual([]);
  });
});
