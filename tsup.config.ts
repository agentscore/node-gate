import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/adapters/express.ts',
    'src/adapters/hono.ts',
    'src/adapters/web.ts',
    'src/adapters/nextjs.ts',
    'src/adapters/fastify.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  define: { __VERSION__: JSON.stringify(version) },
});
