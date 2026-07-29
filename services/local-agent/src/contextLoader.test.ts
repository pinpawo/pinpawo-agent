import assert from 'node:assert/strict';
import test from 'node:test';

test('buildLocalOnlyAgentContext returns an API-free fallback context', async () => {
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = 'https://models.example.test/v1';
  process.env.LLM_MODEL = 'test-model';
  const { LOCAL_ONLY_ACTOR_ID, LOCAL_ONLY_ACTOR_NAME } = await import('./actorSelection');
  const { buildLocalOnlyAgentContext } = await import('./contextLoader');
  const context = buildLocalOnlyAgentContext();

  assert.equal(context.pet.id, LOCAL_ONLY_ACTOR_ID);
  assert.equal(context.pet.name, LOCAL_ONLY_ACTOR_NAME);
  assert.deepEqual(context.context.recentChatTurns, []);
  assert.deepEqual(context.context.recentDaily, []);
  assert.deepEqual(context.context.trendItems, []);
  assert.match(context.context.today, /^\d{4}-\d{2}-\d{2}$/);

});
