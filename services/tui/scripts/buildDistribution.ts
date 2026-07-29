import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const DISTRIBUTION_SCHEMA_VERSION = 1;
const DISTRIBUTION_FORMAT = 'bun-bundle';
const ENTRY_FILE = 'main.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tuiRoot = resolve(scriptDir, '..');
const defaultOutputDir = resolve(tuiRoot, '..', 'local-agent', 'dist', 'tui');
const outputDir = resolveOutputDir(process.argv.slice(2));
const entryPath = resolve(outputDir, ENTRY_FILE);
const manifestPath = resolve(outputDir, 'manifest.json');

const packageJson = JSON.parse(
  await readFile(resolve(tuiRoot, 'package.json'), 'utf8'),
) as {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

await mkdir(outputDir, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(tuiRoot, 'src', 'main.ts')],
  target: 'bun',
  minify: true,
  external: ['@opentui/core'],
  outdir: outputDir,
  naming: ENTRY_FILE,
});
if (!result.success) {
  const details = result.logs.map((log) => log.message).join('\n');
  throw new Error(`TUI distribution build failed${details ? `:\n${details}` : ''}`);
}

const entry = await readFile(entryPath);
const manifest = {
  schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
  format: DISTRIBUTION_FORMAT,
  entry: ENTRY_FILE,
  tuiVersion: packageJson.version,
  bunVersion: exactVersion(packageJson.devDependencies.bun, 'bun'),
  openTuiVersion: exactVersion(
    packageJson.dependencies['@opentui/core'],
    '@opentui/core',
  ),
  bytes: entry.byteLength,
  sha256: createHash('sha256').update(entry).digest('hex'),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[tui:distribution] wrote ${entryPath} (${entry.byteLength} bytes)`,
);

function resolveOutputDir(args: string[]) {
  const index = args.indexOf('--outdir');
  if (index === -1) return defaultOutputDir;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error('--outdir requires a directory');
  return resolve(process.cwd(), value);
}

function exactVersion(value: string | undefined, name: string) {
  if (!value || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${name} must use an exact distribution version`);
  }
  return value;
}
