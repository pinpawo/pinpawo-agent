import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildReviewSpec,
  compileAgentRegistry,
  defineInstructionDocument,
  type AgentModels,
} from '@pinpawo/pet-agent';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import { withScriptedDelegation } from '../../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { FileSaver } from '../fileSaver';
import type { AgentChannelSetup } from './agentChannel';
import { HostGraphService } from './agentGraphService';
import { runAgentSessionTurn } from './chatSessionAdapter';

for (const finalDecision of ['approve', 'cancel'] as const) {
  test(`Host review stays waiting after malformed resumes and restores ${finalDecision} through FileSaver`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-host-review-validation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'checkpoints.json');
    const threadId = `native-review-validation-${finalDecision}`;
    let modelCalls = 0;
    let policyCalls = 0;
    let toolRuns = 0;
    let supervisorCalls = 0;

    class Model extends BaseChatModel {
      _llmType() { return 'native-review-validation'; }
      bindTools() { return this; }
      async _generate(): Promise<never> { throw new Error('expected model streaming'); }
      async *_streamResponseChunks() {
        modelCalls++;
        const message = modelCalls === 1
          ? new AIMessageChunk({ id: 'action-message', content: '', tool_call_chunks: [{
              id: 'call-1', name: 'reviewed_action', args: '{}', index: 0,
            }] })
          : new AIMessageChunk({ id: 'answer-message', content: 'Finished.' });
        yield new ChatGenerationChunk({ text: '', message });
      }
    }
    const model = new Model({});
    const policyModel = { withStructuredOutput: () => ({ invoke: async () => {
      policyCalls++;
      return { riskScore: policyCalls === 1 ? 10 : 1, reason: 'Needs human authorization.' };
    } }) } as unknown as AgentModels['act'];
    const rawTool = tool(async () => { toolRuns++; return 'executed'; }, {
      name: 'reviewed_action', description: 'A reviewed action.', schema: z.object({}),
    });
    const registry = compileAgentRegistry({
      capabilities: [{ name: 'general', description: 'General work.', uses: ['local'],
        instructions: defineInstructionDocument({ content: 'Execute the task.' }) }],
      toolkits: [{ name: 'local', description: 'Local.', tools: [{ tool: rawTool, review: {
        request: () => buildReviewSpec({ view: { kind: 'plain', body: 'Approve this action?' }, options: [
          { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
          { id: 'respond', label: 'Respond', input: { kind: 'text', key: 'message' },
            decision: { type: 'respond', messageInputKey: 'message' } },
        ] }),
      } }] }],
    });
    const entry = { bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: 'entry', name: 'plan_request', args: { goal: 'Inspect.' },
    }] }) }) } as unknown as AgentModels['act'];
    const makeSetup = () => ({
      registry,
      graphConfig: {
        models: { act: entry, answer: entry, decision: policyModel, subagent: model },
        checkpoint: new FileSaver(path),
        runSupervisorRunner: withScriptedDelegation({ invoke: async () => {
          supervisorCalls++;
          if (supervisorCalls === 1) return { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Inspect.' }] } };
          return { reply: 'Done.' };
        } }),
      },
      input: { threadId, messages: [new HumanMessage('Inspect.')], globalReviewPolicy: { mode: 'auto_authorization' } },
      interfaceContext: { kind: 'tui', threadId, capabilities: { humanReview: true, sessionAuthorization: false } },
    } as AgentChannelSetup);
    const events: AgentRuntimeEvent[] = [];
    const consume = async (request: Parameters<typeof runAgentSessionTurn>[0]['request']) => runAgentSessionTurn({
      request, setup: makeSetup(), graphService: new HostGraphService(), isCurrent: () => true,
      emitEvent: event => events.push(event), emitToolEvent: () => {},
    });

    assert.deepEqual(await consume({ kind: 'user_message', requestId: 'initial', message: 'Inspect.' }), { status: 'waiting' });
    const originalPending = (await new HostGraphService().readThreadState(makeSetup())).pendingInterrupt;
    assert.ok(originalPending);
    const reviewId = originalPending.payload.reviews[0]?.id;
    assert.ok(reviewId);
    const invalidResponses = [
      { decisions: 'malformed-native-review-response' },
      { decisions: [{ reviewId, selectedOptionId: 'approve' }], unexpected: true },
      { decisions: [{ reviewId, selectedOptionId: 'approve', unexpected: 'unexpected-native-review-field' }] },
      { decisions: [{ reviewId: ' ', selectedOptionId: 'approve' }] },
      { decisions: [{ reviewId, selectedOptionId: ' ' }] },
      { decisions: [{ reviewId, selectedOptionId: 'respond', input: [] }] },
      { action: 'unsupported-native-review-cancel' },
      { action: 'cancel', unexpected: true },
    ];
    for (const [index, value] of invalidResponses.entries()) {
      const eventStart = events.length;
      assert.deepEqual(await consume({ kind: 'resume', requestId: `invalid-${index}`, resume: {
        interruptId: originalPending.interruptId, value,
      } }), { status: 'waiting' });
      const pending = (await new HostGraphService().readThreadState(makeSetup())).pendingInterrupt;
      assert.equal(pending?.interruptId, originalPending.interruptId);
      assert.equal(pending?.payload.reviews[0]?.id, reviewId);
      assert.equal(pending?.payload.reviews[0]?.view.kind, 'plain');
      assert.deepEqual(pending?.payload.reviews[0]?.view, originalPending.payload.reviews[0]?.view,
        'Host preflight must not mutate the stored review');
      const turnEvents = events.slice(eventStart);
      const waiting = turnEvents.find(event => event.type === 'interrupt.requested');
      assert.ok(waiting);
      assert.notDeepEqual(waiting.pendingInterrupt.payload.interactions[0]?.view, originalPending.payload.reviews[0]?.view,
        'the existing invalid-decision review prompt must be visible to the interface');
      assert.equal(turnEvents.some(event => event.type === 'error' || event.type === 'message.completed'), false);
      assert.equal(modelCalls, 1);
      assert.equal(policyCalls, 1);
      assert.equal(toolRuns, 0);
      const saver = new FileSaver(path);
      for await (const tuple of saver.list({ configurable: { thread_id: threadId } })) {
        const resumes = tuple.pendingWrites?.filter(([, channel]) => channel === '__resume__') ?? [];
        assert.deepEqual(resumes, [], 'Host must reject malformed input before writing any addressed resume');
      }
    }

    // A structurally valid response still passes through the Runtime's
    // option-specific semantic validation and keeps the action parked.
    assert.deepEqual(await consume({ kind: 'resume', requestId: 'missing-text-input', resume: {
      interruptId: originalPending.interruptId,
      value: { decisions: [{ reviewId, selectedOptionId: 'respond' }] },
    } }), { status: 'waiting' });
    assert.equal(policyCalls, 1);
    assert.equal(modelCalls, 1);
    assert.equal(toolRuns, 0);

    await consume({ kind: 'resume', requestId: 'corrected', resume: {
      interruptId: originalPending.interruptId,
      value: finalDecision === 'cancel' ? { action: 'cancel' } : { decisions: [{ reviewId, selectedOptionId: 'approve' }] },
    } });
    assert.equal((await new HostGraphService().readThreadState(makeSetup())).pendingInterrupt, null);
    assert.equal(policyCalls, 1);
    assert.equal(toolRuns, finalDecision === 'approve' ? 1 : 0);
    assert.equal(modelCalls, finalDecision === 'approve' ? 2 : 1);
  });
}
