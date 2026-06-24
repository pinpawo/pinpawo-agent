import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { config } from '../config';
import { buildRunAgentRuntimeConfig } from './run';

test('buildRunAgentRuntimeConfig applies explicit workdir to runtime config and global config fallback', () => {
  const previous = config.workdir;
  const previousCwd = process.cwd();
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-run-workdir-'));
  const expectedWorkdir = realpathSync(workdir);
  try {
    const runtimeConfig = buildRunAgentRuntimeConfig({
      workdir,
    });

    assert.equal(runtimeConfig.workdir, expectedWorkdir);
    assert.equal(config.workdir, expectedWorkdir);
    assert.equal(process.cwd(), expectedWorkdir);
  } finally {
    process.chdir(previousCwd);
    config.workdir = previous;
  }
});
