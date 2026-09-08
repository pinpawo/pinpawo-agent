import assert from 'node:assert/strict';
import test from 'node:test';

test('buildAgentContext returns an API-free fallback context', async () => {
  const { DEFAULT_CHAT_PET } = await import('./defaultPet');
  const { buildAgentContext } = await import('./contextLoader');
  const context = buildAgentContext();

  assert.equal(context.pet.id, DEFAULT_CHAT_PET.petId);
  assert.equal(context.pet.name, DEFAULT_CHAT_PET.name);
  assert.equal(context.traceUserId, undefined);
});
