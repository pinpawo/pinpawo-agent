import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fullOutputNote, saveFullToolOutput } from './toolOutputFile';

test('saveFullToolOutput writes a private file with the full text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-tool-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = saveFullToolOutput('full text', dir);
  assert.ok(path);
  assert.ok(path.startsWith(dir));
  assert.equal(readFileSync(path, 'utf8'), 'full text');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('fullOutputNote is empty when the file cannot be written', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-tool-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, '');
  assert.equal(fullOutputNote('x', blocker), '');
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
