// Test runs keep session state out of the real ~/.pinpawo/workspaces. The
// test runner imports this first and its test files inherit the directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PINPAWO_WORKSPACES_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-test-workspaces-'));
  process.env.PINPAWO_WORKSPACES_DIR = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
