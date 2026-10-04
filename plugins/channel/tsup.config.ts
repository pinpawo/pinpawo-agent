import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  dts: true,
  // Bare `sqlite` is an npm package; keep the explicit Node built-in specifier.
  removeNodeProtocol: false,
});
