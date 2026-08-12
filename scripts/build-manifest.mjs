#!/usr/bin/env node
// Derive grammars/manifest.json from the LANGUAGES table (dist/importers.js) —
// the packaged grammar list cannot drift from the registry. Add a language =
// one LANGUAGES row; every build regenerates the manifest.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES } from '../dist/importers.js';

const langOf = (wasm) => wasm.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '');
const manifest = {
  runtime: 'web-tree-sitter',
  grammars: LANGUAGES.map(({ wasm }) => ({ lang: langOf(wasm), wasm })),
};
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'grammars', 'manifest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest.json: ${manifest.grammars.length} grammar(s) from LANGUAGES`);
