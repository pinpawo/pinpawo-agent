import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cliEntry.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  dts: true,
  // Keep `node:sqlite`: it exists only under the node: scheme, and stripping the
  // prefix turns it into an import of a missing `sqlite` package.
  removeNodeProtocol: false,
});
