import assert from 'node:assert/strict';
import test from 'node:test';
import { browserTools } from './tools';

process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';

function readErrorCode(result: unknown): string | undefined {
  const parsed = JSON.parse(String(result)) as {
    error?: {
      code?: string;
    };
  };
  return parsed.error?.code;
}

test('browser tools require the delegation scope supplied through tool runtime', async () => {
  const snapshotTool = browserTools.find((toolItem) =>
    toolItem.name === 'browser_snapshot');
  assert.ok(snapshotTool);

  const missingScope = await snapshotTool.invoke({});
  assert.equal(readErrorCode(missingScope), 'browser_context_missing');

  const scoped = await snapshotTool.invoke({}, {
    context: {
      executionScope: {
        threadId: 'thread-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
      },
    },
  });
  assert.equal(readErrorCode(scoped), 'browser_not_open');
});
