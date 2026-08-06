import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'hosts/chrome-extension/native-host': 'src/hosts/chromeExtension/nativeHost/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: true,
  splitting: false,
});
