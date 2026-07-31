# grammars/

Bundled tree-sitter grammar WASMs for the language importers. Declared in
`manifest.json`; `cells health` smoke-loads every entry (missing file or ABI
mismatch with the shipped `web-tree-sitter` runtime fails the gate).

## Regenerating a grammar

1. `pnpm add -D tree-sitter-cli` (the CLI used to compile grammar repos to wasm).
2. Clone the grammar repo, e.g. `git clone https://github.com/tree-sitter/tree-sitter-python`.
3. Build with the tree-sitter-cli version whose ABI the bundled `web-tree-sitter`
   runtime accepts. Incompatible builds fail loudly at load ("Incompatible
   language version") — `cells health` confirms the pairing.

   ```sh
   npx tree-sitter-cli build-wasm --output grammars/tree-sitter-python.wasm tree-sitter-python
   ```

4. Run `cells health` — the `grammars` check must stay green.

Do NOT use the prebuilt `tree-sitter-wasms` npm pack: its wasms target the
old CLI/runtime ABI and fail to load.
