import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntimeServiceConfig } from './config';

test('Runtime service config requires an instance kind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-config-'));
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, JSON.stringify({
      instances: { local: { kind: 'shell' } }, toolkitBindings: { bash: 'local' },
    }));
    assert.equal((await loadRuntimeServiceConfig(path)).instances.local?.kind, 'shell');

    await writeFile(path, JSON.stringify({
      instances: { local: {} }, toolkitBindings: { bash: 'local' },
    }));
    await assert.rejects(loadRuntimeServiceConfig(path), { code: 'invalid_config' });

  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
