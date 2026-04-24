import { readFileSync } from 'fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  define: { __VERSION__: JSON.stringify(version) },
  test: {
    environment: 'node',
    setupFiles: ['dotenv/config'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // signer.ts MPP path requires `mppx` as an optional peer dep; the `catch`
      // branch covering a dynamic-import failure isn't reached without installing
      // and mocking mppx, which the gate test env deliberately avoids.
      exclude: ['src/signer.ts', 'tests/**', 'dist/**'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
