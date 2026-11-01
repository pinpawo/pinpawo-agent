import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { Command, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createSubagent, SUBAGENT_GUARD_DECISION_EVENT } from '../../../packages/pet-agent/src/subagent/createSubagent';
import { readSubagentGuardStopReason } from '../../../packages/pet-agent/src/subagent/guardStop';
import { createToolkitReviewMiddleware } from '../../../packages/pet-agent/src/agent/orchestrator/toolkitReviewMiddleware';
import { readPendingInterrupt } from '../../../packages/pet-agent/src/agent/orchestrator/interrupt/readPendingInterrupt';
import { buildReviewSpec } from '../../../packages/pet-agent/src/types/reviewSpec';
import type { GuardDecisionRecord } from '../../../packages/pet-agent/src/guards';
import type { SubagentResult } from '../../../packages/pet-agent/src/types/subagent';
import { FileSaver } from './fileSaver';

function budgetFixture(t: TestContext, maxIterations: number) {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-durable-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'checkpoints.json');
  let modelCalls = 0;
  const effects: number[] = [];
  const results: SubagentResult[] = [];
  const records: GuardDecisionRecord[] = [];
  class ActionModel extends BaseChatModel {
    _llmType() { return 'durable-budget-fixture'; }
    bindTools() { return this; }
    async _generate() {
      modelCalls++;
      return { generations: [{ text: '', message: new AIMessage({ content: '',
        tool_calls: [{ id: `action-${modelCalls}`, name: 'action', args: { number: modelCalls } }],
      }) }] };
    }
  }
  const model = new ActionModel({});
  const action = tool(async ({ number }) => { effects.push(number); return `effect ${number}`; }, {
    name: 'action', description: 'A reviewed side effect.', schema: z.object({ number: z.number() }),
  });
  const config = { configurable: { thread_id: 'durable-budget' } };
  const makeGraph = () => new StateGraph(MessagesAnnotation)
    .addNode('delegate', async (state, runnableConfig) => {
      const review = createToolkitReviewMiddleware([{
        toolkit: { name: 'local', description: 'Local actions.', tools: [{ tool: action }] },
        toolName: 'action', reviewPolicy: {
          request: () => buildReviewSpec({ view: { kind: 'plain', body: 'Approve this action?' }, options: [
            { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
            { id: 'respond', label: 'Respond', input: { kind: 'text', key: 'message' },
              decision: { type: 'respond', messageInputKey: 'message' } },
          ] }),
        },
      }], { models: { act: model }, messages: state.messages,
        reviewCapabilities: { humanReview: true, sessionAuthorization: false },
      });
      assert.ok(review);
      const result = await createSubagent({ model, tools: [action], messages: state.messages,
        promptSections: [], maxIterations, middleware: [review], runnableConfig,
      });
      results.push(result);
      return { messages: result.messages };
    }).addEdge(START, 'delegate').addEdge('delegate', END)
    .compile({ checkpointer: new FileSaver(path) });
  const run = async (input: Parameters<ReturnType<typeof makeGraph>['invoke']>[0]) => {
    // Rebuild both the graph and the actual filesystem saver for every resume.
    const stream = await makeGraph().streamEvents(input, { ...config, version: 'v3' });
    for await (const event of stream) {
      if (event.method !== 'custom') continue;
      const data = event.params.data as { name?: unknown; data?: unknown };
      if (data.name === SUBAGENT_GUARD_DECISION_EVENT) records.push(data.data as GuardDecisionRecord);
    }
    return stream.output;
  };
  const pending = async () => {
    const pending = readPendingInterrupt(await makeGraph().getState(config));
    assert.ok(pending, 'the same delegation remains paused on its reviewed action');
    return pending;
  };
  const resume = async (decision: 'approve' | 'respond' | 'invalid') => {
    const review = await pending();
    return run(new Command({ resume: { [review.interruptId]: decision === 'invalid'
      ? { decisions: [] } : { decisions: [{ reviewId: review.payload.reviews[0].id,
        selectedOptionId: decision, ...(decision === 'respond' ? { input: { message: 'Choose another action.' } } : {}),
      }] },
    } }));
  };
  const assertPersistedCount = async (count: number) => {
    const activeCounts: unknown[] = [];
    for await (const tuple of new FileSaver(path).list(config)) {
      const saved = tuple.checkpoint.channel_values.runModelCallCount;
      if (typeof saved === 'number' && saved > 0) activeCounts.push(saved);
    }
    assert.deepEqual(activeCounts, [count], 'the paused child already checkpointed its completed model calls');
  };
  return { run, resume, pending, assertPersistedCount, effects, results, records, config, makeGraph,
    get modelCalls() { return modelCalls; },
  };
}

for (const decision of ['approve', 'respond'] as const) {
  test(`FileSaver retains one delegation's model budget after repeated invalid responses and ${decision}`, async (t) => {
    const fixture = budgetFixture(t, 1);
    for (let delegation = 1; delegation <= 2; delegation++) {
      await fixture.run({ messages: [new HumanMessage(`Perform delegation ${delegation}.`)] });
      assert.equal(fixture.modelCalls, delegation, 'a fresh delegation has its own budget');
      await fixture.assertPersistedCount(1);
      for (let retry = 0; retry < 3; retry++) {
        await fixture.resume('invalid');
        await fixture.assertPersistedCount(1);
        assert.equal(fixture.modelCalls, delegation);
        assert.equal(fixture.effects.length, decision === 'approve' ? delegation - 1 : 0);
      }
      const output = await fixture.resume(decision);
      assert.equal(fixture.modelCalls, delegation, 'approval or Respond cannot grant another model call');
      assert.equal(fixture.effects.length, decision === 'approve' ? delegation : 0);
      assert.equal(fixture.results.at(-1)?.output, null, 'the budget notice is not a successful deliverable');
      assert.equal(readSubagentGuardStopReason(output.messages.at(-1)!), 'subagent_iteration_limit_reached');
      assert.equal(readPendingInterrupt(await fixture.makeGraph().getState(fixture.config)), null);
      const calls = output.messages.filter(AIMessage.isInstance).flatMap(message => message.tool_calls ?? []);
      const results = output.messages.filter(ToolMessage.isInstance);
      assert.equal(calls.filter(call => call.id === `action-${delegation}`).length, 1);
      assert.equal(results.filter(message => message.tool_call_id === `action-${delegation}`).length, 1);
    }
    assert.deepEqual(fixture.records.map(record => record.iteration), [1, 2, 1, 2]);
    assert.deepEqual(fixture.records.filter(record => record.outcome.kind === 'stop').map(record => record.outcome), [
      { kind: 'stop', reason: 'subagent_iteration_limit_reached', details: { iterationCount: 2, maxIterations: 1 } },
      { kind: 'stop', reason: 'subagent_iteration_limit_reached', details: { iterationCount: 2, maxIterations: 1 } },
    ]);
  });
}

test('FileSaver retains a two-call budget through consecutive approval pauses', async (t) => {
  const fixture = budgetFixture(t, 2);
  await fixture.run({ messages: [new HumanMessage('Perform the reviewed task.')] });
  await fixture.assertPersistedCount(1);
  await fixture.resume('approve');
  assert.equal(fixture.modelCalls, 2);
  assert.deepEqual(fixture.effects, [1]);
  await fixture.assertPersistedCount(2);
  await fixture.resume('invalid');
  await fixture.assertPersistedCount(2);
  const output = await fixture.resume('approve');
  assert.equal(fixture.modelCalls, 2);
  assert.deepEqual(fixture.effects, [1, 2]);
  assert.equal(fixture.results.at(-1)?.output, null);
  assert.equal(readSubagentGuardStopReason(output.messages.at(-1)!), 'subagent_iteration_limit_reached');
  assert.deepEqual(fixture.records.map(record => record.iteration), [1, 2, 3]);
});
