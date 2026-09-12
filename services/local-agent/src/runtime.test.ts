import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_CHAT_PET } from './defaultPet';
import { loadChatPetConfig } from './runtime';
import { buildLocalAgentRuntimeConfig } from './config/runtimeConfig';

async function withWorkdir(run: (workdir: string) => Promise<void>): Promise<void> {
  const workdir = mkdtempSync(path.join(tmpdir(), 'pinpawo-chat-pet-'));
  try {
    await run(workdir);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function writePet(workdir: string, petId: string, config: Record<string, unknown>) {
  const { petsDir } = buildLocalAgentRuntimeConfig(workdir);
  mkdirSync(petsDir, { recursive: true });
  writeFileSync(path.join(petsDir, `${petId}.json`), JSON.stringify(config), 'utf-8');
}

/**
 * An install that never writes a Pet file must behave exactly as it did when
 * the identity was two hardcoded constants — that is what makes this change
 * migration-free.
 */
test('Chat Pet resolution falls back to the built-in Pet when none is configured', async () => {
  await withWorkdir(async (workdir) => {
    const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
    assert.deepEqual(await loadChatPetConfig(runtimeConfig), DEFAULT_CHAT_PET);
  });
});

test('Chat Pet resolution adopts the configured identity and model profile', async () => {
  await withWorkdir(async (workdir) => {
    writePet(workdir, 'writer', {
      petId: 'writer',
      name: '写作助手',
      modelProfileId: 'qwen-max',
      defaultCapabilityName: 'explore',
    });

    const petConfig = await loadChatPetConfig(buildLocalAgentRuntimeConfig(workdir));
    assert.equal(petConfig.petId, 'writer');
    assert.equal(petConfig.name, '写作助手');
    assert.equal(petConfig.modelProfileId, 'qwen-max');
    assert.equal(petConfig.defaultCapabilityName, 'explore');
  });
});

/**
 * Chat runs one Pet by contract, not by current limitation, so a second file is
 * an error that names the Host which does own multi-Pet identity.
 */
test('Chat Pet resolution refuses a second Pet and points at Studio', async () => {
  await withWorkdir(async (workdir) => {
    writePet(workdir, 'writer', { petId: 'writer', name: 'Writer' });
    writePet(workdir, 'reviewer', { petId: 'reviewer', name: 'Reviewer' });

    await assert.rejects(
      () => loadChatPetConfig(buildLocalAgentRuntimeConfig(workdir)),
      /Chat Host runs one Pet, but 2 are configured.*Use Studio/s,
    );
  });
});
