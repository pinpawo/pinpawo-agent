import assert from 'node:assert/strict';
import { ToolMessage } from '@langchain/core/messages';
import test from 'node:test';
import { createDailyPostCapability } from './index';

test('daily_post marks latest tool artifact as a result artifact', async () => {
  const capability = createDailyPostCapability({
    savePost: async () => ({ postId: 'post-1' }),
  });
  const runtime = await capability.createRuntime({} as never);
  const result = await runtime.middleware?.afterRun?.({
    messages: [
      new ToolMessage({
        content: 'created',
        tool_call_id: 'call-1',
        name: 'finalize_post',
        artifact: {
          status: 'created',
          postId: 'post-1',
          reason: null,
          payload: null,
          imageRequested: false,
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
  assert.equal((marker[0] as { schema?: { name?: unknown } }).schema?.name, 'DailyPostResult');
});
