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
 * Chat runs one Pet by contract (§一.8), so a directory holding several belongs
 * to Studio. Chat serves its own standalone Pet rather than picking one of
 * them: `local-only` has its own session namespace, so starting a Chat session
 * here cannot disturb the Pets Studio owns.
 */
test('Chat serves the standalone Pet when the directory holds several', async () => {
  await withWorkdir(async (workdir) => {
    writePet(workdir, 'writer', { petId: 'writer', name: 'Writer' });
    writePet(workdir, 'reviewer', { petId: 'reviewer', name: 'Reviewer' });

    const logged: string[] = [];
    const petConfig = await loadChatPetConfig(
      buildLocalAgentRuntimeConfig(workdir),
      (message) => logged.push(message),
    );

    assert.equal(petConfig.petId, DEFAULT_CHAT_PET.petId);
    // The skipped Pets are named, so serving `local-only` beside them does not
    // read as the Host having silently picked one.
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /2 Pets are configured/);
    assert.match(logged[0]!, /writer/);
    assert.match(logged[0]!, /reviewer/);
    assert.match(logged[0]!, /use Studio/);
  });
});

test('Chat serves the standalone Pet silently when none is configured', async () => {
  await withWorkdir(async (workdir) => {
    const logged: string[] = [];
    const petConfig = await loadChatPetConfig(
      buildLocalAgentRuntimeConfig(workdir),
      (message) => logged.push(message),
    );

    assert.equal(petConfig.petId, DEFAULT_CHAT_PET.petId);
    assert.deepEqual(logged, []);
  });
});
