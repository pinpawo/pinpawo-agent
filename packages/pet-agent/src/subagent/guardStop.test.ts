import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { markSubagentGuardStop, readSubagentGuardStopReason } from './guardStop';

test('the stop marker preserves the native message and its existing fields', () => {
  const message = new AIMessage({
    id: 'native-budget', name: 'native-limiter', content: 'Framework stopping message.',
    additional_kwargs: { native: true, pinpawo: { existing: 'retained' } },
    response_metadata: { source: 'framework' },
    usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  });
  const marked = markSubagentGuardStop(message, 'subagent_iteration_limit_reached');
  assert.equal(marked, message);
  assert.equal(marked.id, 'native-budget');
  assert.equal(marked.name, 'native-limiter');
  assert.equal(marked.content, 'Framework stopping message.');
  assert.deepEqual(marked.response_metadata, { source: 'framework' });
  assert.deepEqual(marked.usage_metadata, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
  assert.deepEqual(marked.additional_kwargs, {
    native: true, pinpawo: { existing: 'retained', subagentGuardStop: 'subagent_iteration_limit_reached' },
  });
  assert.equal(readSubagentGuardStopReason(marked), 'subagent_iteration_limit_reached');
});
