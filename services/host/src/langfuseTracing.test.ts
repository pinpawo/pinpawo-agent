import assert from 'node:assert/strict';
import test from 'node:test';
import { isLangfuseTracingConfigured } from './langfuseTracing';

test('Langfuse tracing requires an explicit enable flag and complete credentials', () => {
  assert.equal(isLangfuseTracingConfigured({
    LANGFUSE_TRACING_ENABLED: 'true',
    LANGFUSE_BASE_URL: 'http://langfuse.test',
    LANGFUSE_PUBLIC_KEY: 'public',
    LANGFUSE_SECRET_KEY: 'secret',
  }), true);
  assert.equal(isLangfuseTracingConfigured({
    LANGFUSE_BASE_URL: 'http://langfuse.test',
    LANGFUSE_PUBLIC_KEY: 'public',
    LANGFUSE_SECRET_KEY: 'secret',
  }), false);
});
