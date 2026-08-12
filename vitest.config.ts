import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/io.ts etc. cover CLI error paths — thresholds below are the
      // measured floor; raise them as error paths gain tests.
      thresholds: {
        // CLI modules (cli/commands/mutate/imports) are exercised black-box via
        // spawned dist/cli.js — v8 never sees them, so 100% is unreachable here.
        // Floor = measured 73.9% lines minus headroom; raises as in-process
        // tests land.
        lines: 70,
        functions: 65,
        statements: 70,
        branches: 60,
      },
    },
  },
});
