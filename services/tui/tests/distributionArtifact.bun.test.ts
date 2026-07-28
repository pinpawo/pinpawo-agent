import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TUI_VERSION } from '../src/version';

const testDir = dirname(fileURLToPath(import.meta.url));
const tuiRoot = resolve(testDir, '..');
const localAgentRoot = resolve(tuiRoot, '..', 'local-agent');

test('distribution bundle builds and boots its external runtime dependencies', async () => {
  const cacheDir = join(localAgentRoot, 'node_modules', '.cache');
  await mkdir(cacheDir, { recursive: true });
  const outputDir = await mkdtemp(join(
    cacheDir,
    'pinpawo-tui-distribution-smoke-',
  ));
  try {
    const build = Bun.spawn([
      process.execPath,
      'run',
      resolve(tuiRoot, 'scripts', 'buildDistribution.ts'),
      '--outdir',
      outputDir,
    ], {
      cwd: tuiRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [buildExitCode, buildStdout, buildStderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    assert.equal(
      buildExitCode,
      0,
      `distribution build failed:\n${buildStderr || buildStdout}`,
    );

    const entryPath = join(outputDir, 'main.js');
    const [entry, manifestText] = await Promise.all([
      readFile(entryPath),
      readFile(join(outputDir, 'manifest.json'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as {
      entry: string;
      tuiVersion: string;
      bytes: number;
      sha256: string;
    };
    assert.equal(manifest.entry, 'main.js');
    assert.equal(manifest.tuiVersion, TUI_VERSION);
    assert.equal(manifest.bytes, entry.byteLength);
    assert.equal(
      manifest.sha256,
      createHash('sha256').update(entry).digest('hex'),
    );

    const probe = Bun.spawn([
      process.execPath,
      'run',
      entryPath,
      '--version',
    ], {
      cwd: localAgentRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [probeExitCode, probeStdout, probeStderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    assert.equal(
      probeExitCode,
      0,
      `distribution probe failed:\n${probeStderr}`,
    );
    assert.equal(probeStderr, '');
    assert.equal(probeStdout, `PinPawo TUI v2 ${TUI_VERSION}\n`);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
