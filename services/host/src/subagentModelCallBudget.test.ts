import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { Command, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createSubagent, SUBAGENT_GUARD_DECISION_EVENT } from '../../../packages/pet-agent/src/subagent/createSubagent';
import { createToolkitReviewMiddleware } from '../../../packages/pet-agent/src/agent/orchestrator/toolkitReviewMiddleware';
import { readPendingInterrupt } from '../../../packages/pet-agent/src/agent/orchestrator/interrupt/readPendingInterrupt';
import { buildReviewSpec } from '../../../packages/pet-agent/src/types/reviewSpec';
import type { GuardDecisionRecord } from '../../../packages/pet-agent/src/guards';
import type { SubagentResult } from '../../../packages/pet-agent/src/types/subagent';
import { FileSaver } from './fileSaver';

function notices(messages: BaseMessage[]) {
  return messages.flatMap((message, index) => {
    if (!ToolMessage.isInstance(message) || message.name !== 'runtime_budget_status') return [];
    const invocation = messages[index - 1];
    assert.ok(AIMessage.isInstance(invocation));
    assert.equal((invocation.additional_kwargs.pinpawo as Record<string, unknown>)?.runtimeNotice, 'subagent_budget');
    assert.equal((message.additional_kwargs.pinpawo as Record<string, unknown>)?.runtimeNotice, 'subagent_budget');
    assert.equal(invocation.tool_calls?.length, 1);
    assert.equal(invocation.tool_calls[0].name, 'runtime_budget_status');
    assert.equal(invocation.tool_calls[0].id, message.tool_call_id);
    const data = JSON.parse(message.text);
    assert.ok(data.phase === 'prepare' || data.phase === 'finalize');
    if (data.reason === 'model_calls') {
      assert.equal(data.remainingModelCalls, data.maxIterations - data.iteration + 1);
      if (data.phase === 'finalize') assert.equal(data.remainingModelCalls, 1);
    } else {
      assert.equal(data.reason, 'context_window');
      assert.equal(data.phase, 'finalize');
      assert.ok(data.estimatedInputTokens >= data.triggerTokens);
      assert.ok(data.estimatedInputTokens < data.inputBudgetTokens);
    }
    assert.equal(typeof data.instruction, 'string');
    return [message];
  });
}

function budgetFixture(t: TestContext, maxIterations: number, initialUnreviewed = 0, options: {
  contextWindowTokens?: number;
  resumeMessage?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-durable-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'checkpoints.json');
  let modelCalls = 0;
  const effects: number[] = [];
  const results: SubagentResult[] = [];
  const records: GuardDecisionRecord[] = [];
  const boundToolCounts: number[] = [];
  const boundToolChoices: unknown[] = [];
  const inputs: BaseMessage[][] = [];
  class ActionModel extends BaseChatModel {
    _llmType() { return 'durable-budget-fixture'; }
    private boundTools = 0;
    private toolChoice: unknown;
    bindTools(tools: unknown[], settings?: Record<string, unknown>) {
      this.boundTools = tools.length;
      this.toolChoice = settings?.tool_choice;
      return this;
    }
    async _generate(messages: BaseMessage[]) {
      inputs.push([...messages]);
      modelCalls++;
      boundToolCounts.push(this.boundTools);
      boundToolChoices.push(this.toolChoice);
      this.boundTools = 0;
      const latest = messages.at(-1);
      const finalize = ToolMessage.isInstance(latest) && latest.name === 'runtime_budget_status' && JSON.parse(latest.text).phase === 'finalize';
      if (finalize) return { generations: [{ text: 'Handoff', message: new AIMessage('Handoff') }] };
      return { generations: [{ text: '', message: new AIMessage({ content: '',
        tool_calls: [{ id: `action-${modelCalls}`, name: modelCalls <= initialUnreviewed ? 'observe' : 'action', args: { number: modelCalls } }],
      }) }] };
    }
  }
  const model = new ActionModel({});
  const action = tool(async ({ number }) => { effects.push(number); return `effect ${number}`; }, {
    name: 'action', description: 'A reviewed side effect.', schema: z.object({ number: z.number() }),
  });
  const observe = tool(async () => 'observed', { name: 'observe', description: 'Inspect.', schema: z.object({ number: z.number() }) });
  const tools = initialUnreviewed ? [action, observe] : [action];
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
      const result = await createSubagent({ model, tools, messages: state.messages,
        promptSections: [], maxIterations, contextWindowTokens: options.contextWindowTokens,
        middleware: [review], runnableConfig,
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
        selectedOptionId: decision, ...(decision === 'respond' ? { input: { message: options.resumeMessage ?? 'Choose another action.' } } : {}),
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
  return { run, resume, pending, assertPersistedCount, effects, results, records, boundToolCounts, boundToolChoices, inputs, config, makeGraph,
    checkpointPath: path,
    get modelCalls() { return modelCalls; },
  };
}

for (const decision of ['approve', 'respond'] as const) {
  test(`FileSaver retains one delegation's model budget after repeated invalid responses and ${decision}`, async (t) => {
    const fixture = budgetFixture(t, 2);
    for (let delegation = 1; delegation <= 2; delegation++) {
      await fixture.run({ messages: [new HumanMessage(`Perform delegation ${delegation}.`)] });
      assert.equal(fixture.modelCalls, (delegation - 1) * 2 + 1, 'a fresh delegation has its own budget');
      await fixture.assertPersistedCount(1);
      for (let retry = 0; retry < 3; retry++) {
        await fixture.resume('invalid');
        await fixture.assertPersistedCount(1);
        assert.equal(fixture.modelCalls, (delegation - 1) * 2 + 1);
        assert.equal(fixture.effects.length, decision === 'approve' ? delegation - 1 : 0);
      }
      const output = await fixture.resume(decision);
      assert.equal(fixture.modelCalls, delegation * 2, 'approval or Respond leaves only the reserved handoff call');
      assert.equal(fixture.effects.length, decision === 'approve' ? delegation : 0);
      assert.equal(fixture.results.at(-1)?.output, 'Handoff');
      assert.equal(output.messages.at(-1)?.text, 'Handoff');
      assert.equal(notices(output.messages).length, delegation, 'one notice per delegation survives resume without duplication');
      assert.equal(notices(fixture.inputs.at(-1)!).length, delegation);
      assert.equal(readPendingInterrupt(await fixture.makeGraph().getState(fixture.config)), null);
      const calls = output.messages.filter(AIMessage.isInstance).flatMap(message => message.tool_calls ?? []);
      const results = output.messages.filter(ToolMessage.isInstance);
      assert.equal(calls.filter(call => call.id === `action-${(delegation - 1) * 2 + 1}`).length, 1);
      assert.equal(results.filter(message => message.tool_call_id === `action-${(delegation - 1) * 2 + 1}`).length, 1);
    }
    assert.deepEqual(fixture.records.map(record => record.iteration), [1, 2, 1, 2]);
    assert.equal(fixture.records.filter(record => record.outcome.kind === 'stop').length, 0);
    assert.deepEqual(fixture.boundToolCounts, [1, 1, 1, 1]);
    assert.equal(fixture.inputs[0].find(message => message._getType() === 'system')?.text, fixture.inputs[1].find(message => message._getType() === 'system')?.text);
    assert.equal(fixture.inputs[2].find(message => message._getType() === 'system')?.text, fixture.inputs[3].find(message => message._getType() === 'system')?.text);
  });
}

test('FileSaver retains a three-call budget through consecutive approval pauses', async (t) => {
  const fixture = budgetFixture(t, 3);
  await fixture.run({ messages: [new HumanMessage('Perform the reviewed task.')] });
  await fixture.assertPersistedCount(1);
  await fixture.resume('approve');
  assert.equal(fixture.modelCalls, 2);
  assert.deepEqual(fixture.effects, [1]);
  await fixture.assertPersistedCount(2);
  await fixture.resume('invalid');
  await fixture.assertPersistedCount(2);
  const output = await fixture.resume('approve');
  assert.equal(fixture.modelCalls, 3);
  assert.deepEqual(fixture.effects, [1, 2]);
  assert.equal(fixture.results.at(-1)?.output, 'Handoff');
  assert.equal(output.messages.at(-1)?.text, 'Handoff');
  assert.deepEqual(fixture.boundToolCounts, [1, 1, 1]);
  assert.equal(notices(output.messages).length, 1);
  assert.equal(notices(fixture.inputs[2]).length, 1);
  assert.equal(fixture.inputs[0].find(message => message._getType() === 'system')?.text, fixture.inputs[2].find(message => message._getType() === 'system')?.text);
  assert.deepEqual(fixture.records.map(record => record.iteration), [1, 2, 3]);
});

test('FileSaver does not duplicate a preparation notice across approval resumes', async (t) => {
  const fixture = budgetFixture(t, 12, 10);
  await fixture.run({ messages: [new HumanMessage('Perform the reviewed task.')] });
  assert.equal(fixture.modelCalls, 11);
  await fixture.assertPersistedCount(11);
  assert.deepEqual(notices(fixture.inputs[10]).map(message => JSON.parse(message.text).phase), ['prepare']);
  for (let retry = 0; retry < 3; retry++) {
    await fixture.resume('invalid');
    await fixture.assertPersistedCount(11);
    assert.equal(fixture.modelCalls, 11);
  }
  const output = await fixture.resume('approve');
  assert.equal(fixture.modelCalls, 12);
  assert.deepEqual(fixture.effects, [11]);
  assert.equal(fixture.results.at(-1)?.output, 'Handoff');
  assert.deepEqual(notices(output.messages).map(message => JSON.parse(message.text).phase), ['prepare', 'finalize']);
  assert.deepEqual(notices(fixture.inputs[11]).map(message => JSON.parse(message.text).phase), ['prepare', 'finalize']);
  assert.ok(fixture.boundToolCounts.every(count => count === 2));
  assert.deepEqual(fixture.records.map(record => record.iteration), Array.from({ length: 12 }, (_, i) => i + 1));
});


test('FileSaver resumes Review Respond into one persisted context handoff without executing the proposed action', async (t) => {
  const fixture = budgetFixture(t, 100, 0, {
    contextWindowTokens: 12_000,
    resumeMessage: 'x'.repeat(44_000),
  });
  await fixture.run({ messages: [new HumanMessage('Perform the reviewed task.')] });
  await fixture.assertPersistedCount(1);
  assert.equal(fixture.modelCalls, 1);
  assert.equal(notices(fixture.inputs[0]).length, 0);
  assert.equal(fixture.effects.length, 0);

  await fixture.resume('invalid');
  await fixture.assertPersistedCount(1);
  assert.equal(fixture.modelCalls, 1, 'an invalid approval response does not call the model');
  const output = await fixture.resume('respond');

  assert.equal(fixture.modelCalls, 2, 'Respond calls the model once for the handoff and never invokes a summarizer');
  assert.deepEqual(fixture.effects, [], 'the previously proposed action remains cancelled');
  assert.deepEqual(fixture.boundToolCounts, [1, 1]);
  assert.deepEqual(fixture.boundToolChoices, [undefined, 'none']);
  assert.equal(fixture.results.at(-1)?.output, 'Handoff');
  assert.equal(output.messages.at(-1)?.text, 'Handoff');
  assert.equal(readPendingInterrupt(await fixture.makeGraph().getState(fixture.config)), null);
  const contextNotices = notices(output.messages);
  assert.equal(contextNotices.length, 1);
  assert.equal(JSON.parse(contextNotices[0].text).reason, 'context_window');
  assert.equal(JSON.parse(contextNotices[0].text).iteration, 2);
  assert.equal(notices(fixture.inputs[1]).length, 1, 'the real model input includes the paired notice');
  assert.ok(output.messages.every((message: BaseMessage) => message.additional_kwargs?.lc_source !== 'summarization'));
  const savedChildMessages: BaseMessage[][] = [];
  for await (const tuple of new FileSaver(fixture.checkpointPath).list(fixture.config)) {
    if (!tuple.config.configurable?.checkpoint_ns) continue;
    const messages = tuple.checkpoint.channel_values.messages;
    if (Array.isArray(messages)) savedChildMessages.push(messages as BaseMessage[]);
  }
  assert.ok(savedChildMessages.some(messages => notices(messages).length === 1
    && notices(messages)[0].id === contextNotices[0].id), 'a freshly loaded saver retains the single child handoff notice');
  assert.deepEqual(fixture.records.map(record => record.iteration), [1, 2]);
});
