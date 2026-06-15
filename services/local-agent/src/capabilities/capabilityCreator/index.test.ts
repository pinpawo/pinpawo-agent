import assert from 'node:assert/strict';
import { ToolMessage } from '@langchain/core/messages';
import test from 'node:test';
import { createCapabilityCreatorCapability } from './index';

test('capability_creator declares read-heavy context policy', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);

  assert.deepEqual(runtime.contextPolicy?.evictToolResults, {
    keepRecent: 5,
    budgetTokens: 24_000,
    keepFailures: true,
  });
});

test('capability_creator marks latest tool artifact as a result artifact', async () => {
  const capability = createCapabilityCreatorCapability();
  const runtime = await capability.createRuntime({} as never);
  const result = await runtime.middleware?.afterRun?.({
    messages: [
      new ToolMessage({
        content: 'created',
        tool_call_id: 'call-1',
        name: 'scaffold_capability_plugin',
        artifact: {
          status: 'created',
          capabilityId: 'demo_capability',
          rootDir: '/tmp/demo',
          files: ['/tmp/demo/manifest.json'],
          note: 'created',
        },
      }),
    ],
    completionReason: 'natural',
  });

  const marker = result?.messages[0]?.additional_kwargs?.pinpawo
    && typeof result.messages[0].additional_kwargs.pinpawo === 'object'
    ? (result.messages[0].additional_kwargs.pinpawo as Record<string, unknown>).capabilityArtifacts
    : null;
  assert.ok(Array.isArray(marker));
  assert.equal((marker[0] as { kind?: unknown }).kind, 'result');
  assert.equal((marker[0] as { schema?: { name?: unknown } }).schema?.name, 'CapabilityCreatorResult');
});
