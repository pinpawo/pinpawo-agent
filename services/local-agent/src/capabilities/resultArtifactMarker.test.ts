import assert from 'node:assert/strict';
import { ToolMessage } from '@langchain/core/messages';
import test from 'node:test';
import { z } from 'zod';
import { markLatestToolArtifactAsResult } from './resultArtifactMarker';

test('markLatestToolArtifactAsResult leaves invalid tool artifacts unmarked', () => {
  const message = new ToolMessage({
    content: 'invalid',
    tool_call_id: 'call-1',
    name: 'finalize',
    artifact: { status: 'failed' },
  });

  const result = markLatestToolArtifactAsResult({
    messages: [message],
    completionReason: 'natural',
  }, {
    schema: z.object({
      status: z.literal('created'),
      id: z.string(),
    }),
    schemaName: 'TestResult',
    title: 'Test result',
  });

  assert.equal(result.messages[0]?.additional_kwargs?.pinpawo, undefined);
});
