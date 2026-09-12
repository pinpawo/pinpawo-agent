import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPetDocumentFile, resolveChatPetDocumentPath } from './petDocument';

test('Chat resolves PET.md directly from its effective workdir', () => {
  assert.equal(
    resolveChatPetDocumentPath('/workspace/project'),
    path.resolve('/workspace/project/PET.md'),
  );
});

test('loadPetDocumentFile reads a Host-resolved PET.md', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-pet-document-'));
  const filePath = path.join(root, 'PET.md');
  await writeFile(filePath, '# Local Pet\n\nWork from the current directory.\n');

  const document = await loadPetDocumentFile(filePath);

  assert.equal(document?.content, '# Local Pet\n\nWork from the current directory.');
  assert.equal(document?.digest.length, 64);
});

test('loadPetDocumentFile returns null when a Host has no authored document', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-pet-document-missing-'));

  assert.equal(await loadPetDocumentFile(path.join(root, 'PET.md')), null);
});
