import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveUserPath } from './pathUtils';

const PATH_UTILS_IMPORT_PATH = process.cwd().endsWith('services/local-agent')
  ? './src/toolkits/local/pathUtils.ts'
  : './services/local-agent/src/toolkits/local/pathUtils.ts';

test('local path utils resolve relative paths from an explicit workdir', () => {
  assert.equal(
    resolveUserPath('notes/todo.md', '/tmp/pinpawo-tools-workdir'),
    '/tmp/pinpawo-tools-workdir/notes/todo.md',
  );
  assert.equal(
    resolveUserPath('/tmp/absolute.txt', '/tmp/pinpawo-tools-workdir'),
    '/tmp/absolute.txt',
  );
});

test('local path utils can load without full config/LLM requirements', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'pinpawo-path-utils-home-'));
  const output = execFileSync(process.execPath, [
    '--import',
    'tsx',
    '-e',
    [
      `const mod = await import(${JSON.stringify(PATH_UTILS_IMPORT_PATH)});`,
      'process.stdout.write(mod.resolveUserPath("notes", process.cwd()));',
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

  assert.equal(output, resolve(process.cwd(), 'notes'));
});
