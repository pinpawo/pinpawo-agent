import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import {
  Annotation, Command, END, START, StateGraph, interrupt, task,
} from '@langchain/langgraph';
import {
  ReviewInterrupt,
  type ReviewInterruptTransition,
} from '../../../../packages/pet-agent/src/agent/orchestrator/interrupt/reviewInterrupt';
import {
  ReviewResponseResolutionError,
} from '../../../../packages/pet-agent/src/agent/orchestrator/review/reviewResponseResolver';
import {
  ReviewEffectApplicationError,
} from '../../../../packages/pet-agent/src/autoReview/reviewAuthorizations';
import { buildReviewSpec } from '../../../../packages/pet-agent/src/types/reviewSpec';
import { FileSaver } from '../fileSaver';

const State = Annotation.Root({
  result: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
});

type Output = typeof State.State & {
  __interrupt__?: Array<{ id?: string; value?: { error?: string }; response_schema?: unknown }>;
};

function makeReview() {
  const toolCall = { id: 'action-1', name: 'action', args: {} };
  const aiMessage = new AIMessage({ id: 'proposed-action', content: '', tool_calls: [toolCall] });
  return new ReviewInterrupt({
    messages: [aiMessage],
    aiMessage,
    aiMessageIndex: 0,
    reviews: [{
      toolCall,
      toolkitName: 'fixture',
      toolName: toolCall.name,
      input: toolCall.args,
      authorizationMatcher: null,
      reviewPayload: {
        kind: 'review',
        review: buildReviewSpec({
          id: 'review-action-1',
          view: { kind: 'plain', body: 'Approve this action?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        }),
      },
    }],
  });
}

/** The pre-schema implementation, including its persisted invalid-resume slots. */
async function runLegacyReview(review: ReviewInterrupt): Promise<ReviewInterruptTransition> {
  let payload = review.interaction();
  while (true) {
    const value = interrupt(payload);
    try {
      return review.materialize(await review.resume(value));
    } catch (error) {
      if (!(error instanceof ReviewResponseResolutionError)
        && !(error instanceof ReviewEffectApplicationError)) throw error;
      payload = { ...payload, error: 'invalid_decision' };
    }
  }
}

function makeGraph(path: string, counters: { policies: number; effects: number }, legacy = false) {
  return new StateGraph(State)
    .addNode('review', async () => {
      await task('review-policy', async () => { counters.policies++; return 'human review'; })();
      const review = makeReview();
      const transition = await (legacy ? runLegacyReview(review) : review.run());
      if (transition.type === 'approve') counters.effects++;
      return { result: transition.type };
    })
    .addEdge(START, 'review').addEdge('review', END)
    .compile({ checkpointer: new FileSaver(path) });
}

const approved = {
  decisions: [{ reviewId: 'review-action-1', selectedOptionId: 'approve' }],
};

test('FileSaver native review validation retains old malformed resume prefixes across reconstruction', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-legacy-review-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'checkpoints.json');
  const config = { configurable: { thread_id: 'legacy-invalid-review' } };
  const counters = { policies: 0, effects: 0 };
  const initial = await makeGraph(path, counters, true).invoke({ result: '' }, config) as Output;
  const interruptId = initial.__interrupt__?.[0]?.id;
  assert.ok(interruptId);
  const legacyInvalid = [{ decisions: [] }, { unexpected: 'legacy malformed response' }];
  for (const value of legacyInvalid) {
    const paused = await makeGraph(path, counters, true).invoke(new Command({
      resume: { [interruptId]: value },
    }), config) as Output;
    assert.equal(paused.__interrupt__?.[0]?.value?.error, 'invalid_decision');
  }
  const taskId = (await makeGraph(path, counters, true).getState(config)).tasks[0]?.id;
  assert.ok(taskId);
  const consumed = async () => (await new FileSaver(path).getTuple(config))?.pendingWrites
    ?.find(([id, channel]) => id === taskId && channel === '__resume__')?.[2];
  assert.deepEqual(await consumed(), legacyInvalid);

  // Structurally valid values still require current review-id/option checks.
  const stale = { decisions: [{ reviewId: 'stale-review', selectedOptionId: 'approve' }] };
  const semanticInvalid = await makeGraph(path, counters).invoke(new Command({
    resume: { [interruptId]: stale },
  }), config) as Output;
  assert.equal(semanticInvalid.__interrupt__?.[0]?.value?.error, 'invalid_decision');
  assert.ok(semanticInvalid.__interrupt__?.[0]?.response_schema);
  assert.deepEqual(await consumed(), [...legacyInvalid, stale]);

  const malformed = await makeGraph(path, counters).invoke(new Command({
    resume: { [interruptId]: { action: 'cancel', unexpected: true } },
  }), config) as Output;
  assert.equal(malformed.__interrupt__?.[0]?.value?.error, 'invalid_decision');
  assert.deepEqual(await consumed(), [...legacyInvalid, stale],
    'native structural validation must not append another consumed resume slot');
  assert.deepEqual(counters, { policies: 1, effects: 0 });

  const done = await makeGraph(path, counters).invoke(new Command({
    resume: { [interruptId]: approved },
  }), config);
  assert.equal(done.result, 'approve');
  assert.deepEqual(counters, { policies: 1, effects: 1 });
  assert.deepEqual((await makeGraph(path, counters).getState(config)).next, []);
});

test('direct native review callers reject malformed addressed input without consuming resume history', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-direct-review-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'checkpoints.json');
  const config = { configurable: { thread_id: 'direct-invalid-review' } };
  const counters = { policies: 0, effects: 0 };
  const initial = await makeGraph(path, counters).invoke({ result: '' }, config) as Output;
  const interruptId = initial.__interrupt__?.[0]?.id;
  assert.ok(interruptId);
  assert.ok(initial.__interrupt__?.[0]?.response_schema);
  const taskId = (await makeGraph(path, counters).getState(config)).tasks[0]?.id;
  assert.ok(taskId);
  const bad = { decisions: [{ reviewId: 'review-action-1', selectedOptionId: 42 }] };

  for (let attempt = 0; attempt < 2; attempt++) {
    const paused = await makeGraph(path, counters).invoke(new Command({
      resume: { [interruptId]: bad },
    }), config) as Output;
    assert.equal(paused.__interrupt__?.[0]?.id, interruptId);
    assert.equal(paused.__interrupt__?.[0]?.value?.error, 'invalid_decision');
    const writes = (await new FileSaver(path).getTuple(config))?.pendingWrites ?? [];
    assert.equal(writes.some(([id, channel]) => id === taskId && channel === '__resume__'), false,
      'malformed values must not become consumed node-task resume history');
    // LangGraph records addressed Command input routing before interrupt() runs.
    // Host preflight prevents this write; direct graph callers retain that
    // upstream routing entry, distinct from successfully consumed resume slots.
    assert.ok(writes.some(([id, channel, value]) => id === interruptId && channel === '__resume__'
      && JSON.stringify(value).includes(JSON.stringify(bad))));
    assert.deepEqual(counters, { policies: 1, effects: 0 });
  }

  const done = await makeGraph(path, counters).invoke(new Command({
    resume: { [interruptId]: approved },
  }), config);
  assert.equal(done.result, 'approve');
  assert.deepEqual(counters, { policies: 1, effects: 1 });
});
