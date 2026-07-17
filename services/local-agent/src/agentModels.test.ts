import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalAgentModels } from './agentModels';

function readTemperature(model: unknown): number | undefined {
  return (model as { temperature?: number }).temperature;
}

test('models use the provider temperature default when no override is configured', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'k3',
    observeModel: 'k3',
    contextWindowTokens: 1_048_576,
  });

  assert.equal(readTemperature(models.act), undefined);
  assert.equal(readTemperature(models.observe), undefined);
  assert.equal(readTemperature(models.subagent), undefined);
});

test('an explicit temperature override applies consistently to every role', () => {
  const models = buildLocalAgentModels({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'custom-model',
    observeModel: 'custom-model',
    temperature: 0.2,
  });

  assert.equal(readTemperature(models.act), 0.2);
  assert.equal(readTemperature(models.observe), 0.2);
  assert.equal(readTemperature(models.subagent), 0.2);
});
