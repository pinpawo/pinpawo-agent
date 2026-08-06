import { defineConfig } from 'tsup';
import { copyFile, mkdir } from 'node:fs/promises';

// Packages with CJS internals that require Node.js built-ins at runtime —
// keep them external so node_modules (rsync'd into the .app bundle) resolves them.
const CJS_EXTERNALS = [
  'ws',
  'ws/*',
  // ripgrep: runtime-resolved platform package with a native binary
  '@vscode/ripgrep',
  '@vscode/ripgrep/*',
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
    'toolkits/browser/native-host': 'src/toolkits/browser/drivers/chromeExtension/nativeHost/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  onSuccess: async () => {
    await Promise.all(['general', 'capabilityCreator'].map(async (capability) => {
      const targetDir = `dist/capabilities/${capability}`;
      await mkdir(targetDir, { recursive: true });
      await copyFile(
        `src/capabilities/${capability}/CAPABILITY.md`,
        `${targetDir}/CAPABILITY.md`,
      );
    }));
  },
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
