import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

const APPLICATION_RUNTIME_EXTERNALS = [
  'pinpawo',
  'pinpawo/*',
  'ws',
  'ws/*',
  '@vscode/ripgrep',
  '@vscode/ripgrep/*',
  'playwright-core',
  'playwright-core/*',
  'playwright',
  'playwright/*',
  'chromium-bidi',
  'chromium-bidi/*',
];

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  dts: false,
  noExternal: [/.+/],
  onSuccess: async () => {
    await mkdir('dist', { recursive: true });
    await copyFile(
      '../../toolkits/studio-kanban/src/STUDIO_PLANNING_CAPABILITY.md',
      'dist/STUDIO_PLANNING_CAPABILITY.md',
    );
  },
  banner: {
    js: `import { createRequire as __pinpawoCreateRequire } from 'module'; const require = __pinpawoCreateRequire(import.meta.url);`,
  },
  esbuildOptions(options) {
    options.external = [...(options.external ?? []), ...APPLICATION_RUNTIME_EXTERNALS];
  },
});
