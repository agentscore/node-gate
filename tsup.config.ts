import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  define: { __VERSION__: JSON.stringify(version) },
});
