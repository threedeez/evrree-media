import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'client/index': 'src/client/index.ts',
    'nestjs/index': 'src/nestjs/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  // Shared code (MediaClient, MediaError) goes into common chunks rather than being copied
  // into each entry, so `@evrree/media/nestjs` hands out the very same MediaClient class and
  // `instanceof MediaError` holds across entry points. Enabled for CJS too, where it is off
  // by default.
  splitting: true,
  external: ['@nestjs/common', 'reflect-metadata', /^@aws-sdk\//],
});
