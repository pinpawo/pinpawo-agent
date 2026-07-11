import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getConfig, setConfig } from '../config';
import { buildRunAgentRuntimeConfig } from './run';

test('buildRunAgentRuntimeConfig applies explicit workdir to runtime config and global config fallback', () => {
  const previous = getConfig().workdir;
  const previousCwd = process.cwd();
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-run-workdir-'));
  const expectedWorkdir = realpathSync(workdir);
  try {
    const runtimeConfig = buildRunAgentRuntimeConfig({
      workdir,
    });

    assert.equal(runtimeConfig.workdir, expectedWorkdir);
    assert.equal(getConfig().workdir, expectedWorkdir);
    assert.equal(process.cwd(), expectedWorkdir);
  } finally {
    process.chdir(previousCwd);
    setConfig({ workdir: previous });
  }
});
