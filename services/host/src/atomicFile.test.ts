import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWriteFile } from './atomicFile';

test('atomicWriteFile replaces the file whole and leaves no temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  try {
    const path = join(dir, 'nested', 'state.json');
    atomicWriteFile(path, '{"v":1}');
    atomicWriteFile(path, '{"v":2}');
    assert.equal(readFileSync(path, 'utf-8'), '{"v":2}');
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['state.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomicWriteFile removes its temporary file when the replacement fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-write-fail-'));
  try {
    const path = join(dir, 'occupied');
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'x');
    assert.throws(() => atomicWriteFile(path, 'data'));
    assert.deepEqual(readdirSync(dir), ['occupied']);
    assert.equal(readFileSync(join(path, 'keep'), 'utf-8'), 'x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomicWriteFile keeps the mode of the file it replaces', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-write-mode-'));
  try {
    const script = join(dir, 'run.sh');
    writeFileSync(script, 'old');
    chmodSync(script, 0o755);
    atomicWriteFile(script, 'new');
    assert.equal(statSync(script).mode & 0o7777, 0o755);

    const secret = join(dir, 'config.json');
    writeFileSync(secret, '{}');
    chmodSync(secret, 0o600);
    atomicWriteFile(secret, '{"v":1}');
    assert.equal(statSync(secret).mode & 0o7777, 0o600);
    assert.equal(readFileSync(secret, 'utf-8'), '{"v":1}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
