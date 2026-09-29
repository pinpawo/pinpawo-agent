import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadGeneralCapability } from './index';

test('General Capability retains its authored CAPABILITY.md provenance', async () => {
  const capability = loadGeneralCapability();

  assert.ok(capability);
  assert.equal(capability.name, 'general');
  assert.match(capability.document?.filePath ?? '', /CAPABILITY\.md$/);
  assert.match(capability.document?.digest ?? '', /^[a-f0-9]{64}$/);
  assert.match(
    await readFile(capability.document!.filePath, 'utf8'),
    /name:\s*general/,
  );
});
