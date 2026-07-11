import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStartupConfigSnapshot,
  formatStartupConfigSnapshot,
} from './startupConfigLog';

test('startup config snapshot prints non-sensitive runtime configuration', () => {
  const previousTracing = process.env.LANGSMITH_TRACING;
  const previousProject = process.env.LANGSMITH_PROJECT;
  const previousEndpoint = process.env.LANGSMITH_ENDPOINT;
  const previousApiKey = process.env.LANGSMITH_API_KEY;
  try {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_PROJECT = 'pinpet-local-agent';
    process.env.LANGSMITH_ENDPOINT = 'https://api.smith.langchain.com';
    process.env.LANGSMITH_API_KEY = 'secret-key-value';

    const text = formatStartupConfigSnapshot(buildStartupConfigSnapshot({
      mode: 'run',
      workdir: '/tmp/workdir',
      actorId: 'pet-1',
      actorName: '小白',
    }));

    assert.match(text, /langsmithTracing=true/);
    assert.match(text, /langsmithProject=pinpet-local-agent/);
    assert.match(text, /langsmithEndpoint=https:\/\/api\.smith\.langchain\.com/);
    assert.doesNotMatch(text, /secret-key-value/);
    assert.doesNotMatch(text, /LANGSMITH_API_KEY|LLM_API_KEY|AGENT_TOKEN|HASURA_JWT/i);
  } finally {
    if (previousTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = previousTracing;
    if (previousProject === undefined) delete process.env.LANGSMITH_PROJECT;
    else process.env.LANGSMITH_PROJECT = previousProject;
    if (previousEndpoint === undefined) delete process.env.LANGSMITH_ENDPOINT;
    else process.env.LANGSMITH_ENDPOINT = previousEndpoint;
    if (previousApiKey === undefined) delete process.env.LANGSMITH_API_KEY;
    else process.env.LANGSMITH_API_KEY = previousApiKey;
  }
});
