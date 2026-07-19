import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { setPinpetMeta } from '../messageLanes';
import { selectReviewUserRequests } from './reviewContext';

test('selectReviewUserRequests keeps only the latest two original user messages', () => {
  const syntheticHuman = new HumanMessage('Synthetic subagent instruction');
  setPinpetMeta(syntheticHuman, {
    lane: 'general',
    runId: 'run-1',
    delegationId: 'delegation-1',
  });

  const requests = selectReviewUserRequests([
    new HumanMessage('Old request that is no longer needed'),
    new AIMessage('Intermediate assistant update'),
    new HumanMessage('Original task request'),
    syntheticHuman,
    new HumanMessage('Continue with that task'),
  ]);

  assert.deepEqual(requests, [
    'Original task request',
    'Continue with that task',
  ]);
});
