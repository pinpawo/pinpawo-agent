import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { USER_GOAL_MAX_CHARS } from '../../capabilityPlanner/runner';
import { readUserGoalText } from './orchestrationDecision';

test('Goal Creation accepts the complete trimmed model text as UserGoal', () => {
  assert.equal(
    readUserGoalText(new AIMessage('  检查 /repo 并保留 issue #619 的限制。  ')),
    '检查 /repo 并保留 issue #619 的限制。',
  );
});

test('Goal Creation fails closed for empty and oversized text', () => {
  assert.throws(
    () => readUserGoalText(new AIMessage('   ')),
    /non-empty text response/,
  );
  assert.throws(
    () => readUserGoalText(new AIMessage('x'.repeat(USER_GOAL_MAX_CHARS + 1))),
    /exceeds 6000 characters/,
  );
});
