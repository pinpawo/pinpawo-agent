import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoveMessage, ToolMessage, type ToolCall } from '@langchain/core/messages';
import { ReviewInterrupt, type ReviewInterruptReview } from './reviewInterrupt';
import { buildReviewSpec, type HumanReviewInterruptPayload } from '../review/reviewSpec';

const toolCalls: ToolCall[] = [
  { id: 'call-1', name: 'run_shell', args: { command: 'git status' }, type: 'tool_call' },
  { id: 'call-2', name: 'run_shell', args: { command: 'git diff' }, type: 'tool_call' },
];

function reviewPayload(toolCall: ToolCall): HumanReviewInterruptPayload {
  return {
    kind: 'review',
    review: buildReviewSpec({
      id: `review-${toolCall.id}`,
      view: { kind: 'plain', body: 'Review shell command' },
      options: [
        { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
        {
          id: 'reject',
          label: 'Reject',
          decision: { type: 'reject', message: 'Do not run this command.' },
        },
        {
          id: 'respond',
          label: 'Respond',
          input: { kind: 'text', key: 'message' },
          decision: { type: 'respond', messageInputKey: 'message' },
        },
      ],
    }),
    pendingAction: {
      actionId: toolCall.id!,
      toolName: toolCall.name,
      args: toolCall.args,
    },
  };
}

function reviews(): ReviewInterruptReview[] {
  return toolCalls.map((toolCall) => ({
    toolCall,
    toolkitName: 'local',
    toolName: toolCall.name,
    input: toolCall.args,
    reviewPayload: reviewPayload(toolCall),
    authorizationMatcher: null,
  }));
}

function createReviewInterrupt() {
  return new ReviewInterrupt({
    reviews: reviews(),
    toolCalls,
    aiMessageId: 'ai-action',
  });
}

test('ReviewInterrupt encapsulates approve resolution', async () => {
  const result = await createReviewInterrupt().resume({
    decisions: toolCalls.map((toolCall) => ({
      reviewId: `review-${toolCall.id}`,
      selectedOptionId: 'approve',
    })),
  });

  assert.equal(result.type, 'approve');
  assert.equal(result.next, 'tools');
  assert.deepEqual(result.type === 'approve' ? result.approvedReviewIds : [], [
    'review-call-1',
    'review-call-2',
  ]);
});

test('ReviewInterrupt encapsulates respond resolution', async () => {
  const result = await createReviewInterrupt().resume({
    decisions: [{
      reviewId: 'review-call-1',
      selectedOptionId: 'respond',
      input: { message: 'Use the read-only command instead.' },
    }],
  });

  assert.equal(result.type, 'respond');
  assert.equal(result.next, 'model');
  assert.equal(result.type === 'respond' && result.messages.length, 2);
  assert.ok(result.type === 'respond' && result.messages.every(ToolMessage.isInstance));
});

test('ReviewInterrupt encapsulates reject resolution without removing the action', async () => {
  const result = await createReviewInterrupt().resume({
    decisions: [{
      reviewId: 'review-call-1',
      selectedOptionId: 'reject',
    }],
  });

  assert.equal(result.type, 'reject');
  assert.equal(result.next, 'pause_task');
  assert.ok(result.type === 'reject' && result.messages.every(ToolMessage.isInstance));
  assert.match(String(result.type === 'reject' && result.messages[0]?.content), /Do not run/);
});

test('ReviewInterrupt encapsulates cancel resolution by removing the proposed action', async () => {
  const result = await createReviewInterrupt().resume({ action: 'cancel' });

  assert.equal(result.type, 'cancel');
  assert.equal(result.next, 'pause_task');
  assert.equal(result.type === 'cancel' && result.messages.length, 1);
  assert.ok(result.type === 'cancel' && result.messages[0] instanceof RemoveMessage);
});
