import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fullOutputNote, saveFullToolOutput } from './toolOutputFile';

test('cleanup failure preserves the original output-write error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-output-errors-'));
  const remove = fs.rmSync;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    remove(dir, { recursive: true, force: true });
  });
  t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('write failed'), { code: 'ENOSPC' }); });
  t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('cleanup failed'), { code: 'EPERM' }); });
  syncBuiltinESMExports();
  assert.deepEqual(saveFullToolOutput('captured output', dir), { error: 'ENOSPC' });
  assert.match(fullOutputNote('captured output', dir), /not saved \(ENOSPC\), omitted part is lost/);
});

test('saveFullToolOutput writes a private file with the full text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-tool-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = saveFullToolOutput('full text', dir);
  assert.ok('path' in saved);
  const { path } = saved;
  assert.ok(path.startsWith(dir));
  assert.equal(readFileSync(path, 'utf8'), 'full text');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('fullOutputNote says why the file could not be written', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-tool-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, '');
  assert.match(fullOutputNote('x', blocker), /^; full output not saved \((EEXIST|ENOTDIR)\), omitted part is lost$/);
});

test('the first write prunes files older than a week', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-tool-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, 'old.txt');
  const recent = join(dir, 'recent.txt');
  writeFileSync(old, 'old');
  writeFileSync(recent, 'recent');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(old, eightDaysAgo, eightDaysAgo);
  saveFullToolOutput('new', dir);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
});
