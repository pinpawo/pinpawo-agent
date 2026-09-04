import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, RemoveMessage, ToolMessage, type ToolCall } from '@langchain/core/messages';
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
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
  const aiMessage = new AIMessage({
    id: 'ai-action',
    content: '',
    tool_calls: toolCalls,
  });
  return new ReviewInterrupt({
    reviews: reviews(),
    messages: [aiMessage],
    aiMessage,
    aiMessageIndex: 0,
    actionWasMaterialized: false,
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

test('ReviewInterrupt re-interrupts after an invalid resume before accepting a valid decision', async () => {
  const HarnessState = Annotation.Root({
    outcome: Annotation<string | null>({
      reducer: (_current, next) => next,
      default: () => null,
    }),
  });
  const graph = new StateGraph(HarnessState)
    .addNode('review', async () => {
      const transition = await createReviewInterrupt().run();
      return { outcome: transition.type };
    })
    .addEdge(START, 'review')
    .addEdge('review', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'review-invalid-resume' } };

  const initial = await graph.invoke({ outcome: null }, config) as {
    __interrupt__?: Array<{ value?: { kind?: string; error?: string } }>;
  };
  assert.equal(initial.__interrupt__?.[0]?.value?.kind, 'review_batch');
  assert.equal(initial.__interrupt__?.[0]?.value?.error, undefined);

  const invalid = await graph.invoke(
    new Command({ resume: { decisions: [] } }),
    config,
  ) as {
    __interrupt__?: Array<{
      value?: { kind?: string; error?: string };
    }>;
  };
  assert.equal(invalid.__interrupt__?.[0]?.value?.kind, 'review_batch');
  assert.equal(invalid.__interrupt__?.[0]?.value?.error, 'invalid_decision');

  const completed = await graph.invoke(new Command({
    resume: {
      decisions: toolCalls.map((toolCall) => ({
        reviewId: `review-${toolCall.id}`,
        selectedOptionId: 'approve',
      })),
    },
  }), config) as { outcome: string | null; __interrupt__?: unknown };
  assert.equal(completed.outcome, 'approve');
  assert.equal(completed.__interrupt__, undefined);
});
