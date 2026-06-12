import assert from 'node:assert/strict';
import test from 'node:test';

const REQUIRED_ENV = {
  API_BASE_URL: 'https://example.test',
  HASURA_ENDPOINT: 'https://example.test/v1/graphql',
  AGENT_TOKEN: 'agent-token',
  HASURA_JWT: 'hasura-jwt',
  LLM_API_KEY: 'llm-key',
};

async function loadConfigHelpers() {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    process.env[key] = value;
  }
  return import('./config');
}

test('resolveNumberConfigValue falls back to stored number for empty env values', async () => {
  const { resolveNumberConfigValue } = await loadConfigHelpers();
  assert.equal(resolveNumberConfigValue('', 131072), 131072);
  assert.equal(resolveNumberConfigValue('   ', 131072), 131072);
});

test('resolveNumberConfigValue prefers valid env number over stored number', async () => {
  const { resolveNumberConfigValue } = await loadConfigHelpers();
  assert.equal(resolveNumberConfigValue('64000', 131072), 64000);
});

test('isGeneratedPlaceholderConfigValue detects init template placeholders', async () => {
  const { isGeneratedPlaceholderConfigValue } = await loadConfigHelpers();
  assert.equal(isGeneratedPlaceholderConfigValue('API_BASE_URL', 'https://your-api.example.com'), true);
  assert.equal(isGeneratedPlaceholderConfigValue('HASURA_JWT', 'eyJ...'), true);
  assert.equal(isGeneratedPlaceholderConfigValue('LLM_API_KEY', 'real-key'), false);
});

test('resolveConnectionMode allows local-only mode without API credentials', async () => {
  const { resolveConnectionMode } = await loadConfigHelpers();
  assert.equal(resolveConnectionMode({
    apiBaseUrl: '',
    hasuraEndpoint: '',
    agentToken: '',
    hasuraJwt: '',
  }), 'local-only');
  assert.equal(resolveConnectionMode({
    apiBaseUrl: 'https://api.example.test',
    hasuraEndpoint: 'https://hasura.example.test/v1/graphql',
    agentToken: 'agent-token',
    hasuraJwt: 'jwt',
  }), 'api-connected');
});
