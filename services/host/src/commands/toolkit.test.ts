import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runToolkitCommand } from './toolkit';

test('toolkit status reads real managed state and unknown requests fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office status '));
  let output = '';
  try {
    await runToolkitCommand('status', 'office', { dir: root, write: (text) => { output += text; } });
    const status = JSON.parse(output);
    assert.equal(status.state, 'missing');
    assert.equal(status.version, '1.0.156');
    assert.equal(status.path, join(root, 'office', '1.0.156', 'officecli'));
    await assert.rejects(runToolkitCommand('install', 'unknown'), /Unknown Toolkit/);
    await assert.rejects(runToolkitCommand('update', 'office'), /Unknown toolkit action/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
