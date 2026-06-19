import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  getLocalToolsWorkdir,
  resolveUserPath,
  setLocalToolsWorkdir,
} from './pathUtils';

test('local path utils resolve relative paths from the local tools workdir', () => {
  const previous = getLocalToolsWorkdir();
  try {
    setLocalToolsWorkdir('/tmp/pinpawo-tools-workdir');
    assert.equal(resolveUserPath('notes/todo.md'), '/tmp/pinpawo-tools-workdir/notes/todo.md');
    assert.equal(resolveUserPath('/tmp/absolute.txt'), '/tmp/absolute.txt');
  } finally {
    setLocalToolsWorkdir(previous);
  }
});

test('local path utils can load without full config/LLM requirements', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-path-utils-home-'));
  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      'const mod = await import("./src/toolkits/local/pathUtils.ts");',
      'process.stdout.write(mod.getLocalToolsWorkdir());',
    ].join('\n'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PINPAWO_WORKDIR: '',
      LLM_API_KEY: '',
    },
    encoding: 'utf8',
  });

  assert.equal(output, process.cwd());
});
