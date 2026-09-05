import assert from 'node:assert/strict';
import test from 'node:test';

test('buildAgentContext returns an API-free fallback context', async () => {
  const { LOCAL_ACTOR_ID, LOCAL_ACTOR_NAME } = await import('./actorSelection');
  const { buildAgentContext } = await import('./contextLoader');
  const context = buildAgentContext();

  assert.equal(context.pet.id, LOCAL_ACTOR_ID);
  assert.equal(context.pet.name, LOCAL_ACTOR_NAME);
  assert.equal(context.actor, undefined);
});
