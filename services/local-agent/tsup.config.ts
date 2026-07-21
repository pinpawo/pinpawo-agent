import { defineConfig } from 'tsup';

// Packages with CJS internals that require Node.js built-ins at runtime —
// keep them external so node_modules (rsync'd into the .app bundle) resolves them.
const CJS_EXTERNALS = [
  'ws',
  'ws/*',
  // playwright / chromium: native binaries, never bundle
  'playwright-core',
  'playwright-core/*',
  'playwright',
  'playwright/*',
  'chromium-bidi',
  'chromium-bidi/*',
];

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'native-host': 'src/toolkits/browser/drivers/chromeExtension/nativeHost/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  // Manually inject createRequire so the bundled CJS __require shim can
  // resolve Node.js built-ins (events, stream, punycode, …) at runtime.
  banner: {
    js: `import { createRequire as __pinpawoCreateRequire } from 'module'; const require = __pinpawoCreateRequire(import.meta.url);`,
  },
  noExternal: [/.+/],
  esbuildOptions(options) {
    options.external = [...(options.external ?? []), ...CJS_EXTERNALS];
  },
});
