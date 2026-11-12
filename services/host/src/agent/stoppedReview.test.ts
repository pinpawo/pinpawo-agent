import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildReviewSpec, compileAgentRegistry, defineInstructionDocument, type AgentModels } from '@pinpawo/pet-agent';
import { withScriptedDelegation } from '../../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { FileSaver } from '../fileSaver';
import { HostGraphService } from './agentGraphService';
import { runAgentSessionTurn, type AgentSessionTurnRequest } from './chatSessionAdapter';
import type { AgentChannelSetup } from './agentChannel';

const respondText = '  ONLY_READ_FIXTURE_1089\n只读核验 🧪\n保留内部换行  ';
for (const decision of ['respond', 'approve'] as const) {
  test(`stop after consumed ${decision} closes stale review without resuming child`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'pinpawo-stopped-review-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'checkpoints.json');
    const threadId = `probe-${decision}`;
    const counts = { entry: 0, supervisor: 0, model: 0, tools: 0, policy: 0 };
    let enteredSecond!: () => void;
    const secondEntered = new Promise<void>(resolve => enteredSecond = resolve);
    class Model extends BaseChatModel {
      _llmType() { return 'probe-review-stop'; }
      bindTools() { return this; }
      async _generate(): Promise<never> { throw new Error('stream expected'); }
      async *_streamResponseChunks(_messages: BaseMessage[], options: { signal?: AbortSignal }) {
        counts.model++;
        if (counts.model === 1) {
          const chunks = [
            new AIMessageChunk({ id: 'action', content: [{ type: 'reasoning', reasoning: 'fixture', index: 0 }] }),
            new AIMessageChunk({ id: 'action', content: [{ type: 'text', text: 'Review action', index: 1 }] }),
            new AIMessageChunk({ id: 'action', content: [{ type: 'text', text: '.', index: 1 }], tool_call_chunks: [{ id: 'reviewed-call', name: 'reviewed_action', args: '{"value":"', index: 2 }] }),
            new AIMessageChunk({ id: 'action', content: '', tool_call_chunks: [{ args: 'original"}', index: 2 }] }),
          ];
          for (const message of chunks) yield new ChatGenerationChunk({ text: '', message });
        } else if (counts.model === 2) {
          const signal = options.signal;
          assert.ok(signal, 'real graph must forward cancellation signal');
          enteredSecond();
          await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        } else {
          yield new ChatGenerationChunk({ text: 'continued after obsolete review cancel', message: new AIMessageChunk({ id: `finish-${counts.model}`, content: 'continued after obsolete review cancel' }) });
        }
      }
    }
    const model = new Model({});
    const action = tool(async () => { counts.tools++; return 'executed-once'; }, { name: 'reviewed_action', description: 'Fixture only.', schema: z.object({ value: z.string() }) });
    const registry = compileAgentRegistry({
      capabilities: [{ name: 'general', description: 'General work.', uses: ['local'], instructions: defineInstructionDocument({ content: 'Execute fixture task.' }) }],
      toolkits: [{ name: 'local', description: 'Fixture.', tools: [{ tool: action, review: { request: () => buildReviewSpec({ view: { kind: 'plain', body: 'Approve?' }, options: [
        { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
        { id: 'respond', label: 'Respond', input: { kind: 'text', key: 'message' }, decision: { type: 'respond', messageInputKey: 'message' } },
      ] }) } }] }],
    });
    const entry = { bindTools: () => ({ invoke: async () => { counts.entry++; return new AIMessage({ content: '', tool_calls: [{ id: `entry-${counts.entry}`, name: 'plan_request', args: { goal: 'Probe.' } }] }); } }) } as unknown as AgentModels['act'];
    const policy = { withStructuredOutput: () => ({ invoke: async () => { counts.policy++; return { riskScore: 10, reason: 'Fixture requires human response.' }; } }) } as unknown as AgentModels['act'];
    function setup(signal?: AbortSignal): AgentChannelSetup {
      return {
        registry,
        graphConfig: { models: { act: entry, answer: entry, decision: policy, subagent: model }, checkpoint: new FileSaver(path), runSupervisorRunner: withScriptedDelegation({ invoke: async () => {
          counts.supervisor++;
          if (counts.supervisor === 1) return { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Probe.' }] } };
          return { reply: 'Done.' };
        } }) },
        input: { threadId, messages: [new HumanMessage('Probe.')], globalReviewPolicy: { mode: 'auto_authorization' }, ...(signal ? { signal } : {}) },
        interfaceContext: { kind: 'tui', threadId, capabilities: { humanReview: true, sessionAuthorization: false } },
      } as AgentChannelSetup;
    }
    const service = new HostGraphService();
    const invoke = (request: AgentSessionTurnRequest, currentSetup: AgentChannelSetup) => runAgentSessionTurn({ request, setup: currentSetup, graphService: service, isCurrent: () => true, emitEvent: () => {}, emitToolEvent: () => {} });
    const first = await invoke({ kind: 'user_message', requestId: 'first', message: 'Probe.' }, setup());
    const pending = (await service.readThreadState(setup())).pendingInterrupt!;
    assert.equal(first.status, 'waiting');
    assert.ok(pending);
    const control = new AbortController();
    const resume = invoke({ kind: 'resume', requestId: 'answer', resume: { interruptId: pending.interruptId, value: { decisions: [{ reviewId: pending.payload.reviews[0].id, selectedOptionId: decision, ...(decision === 'respond' ? { input: { message: respondText } } : {}) }] } } }, setup(control.signal));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([secondEntered, resume.then(() => { throw new Error('finished before second model entered'); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('no second model within 5s')), 5000); })]);
    } finally {
      clearTimeout(timeout);
    }
    control.abort(new Error('SYSTEM_STOP_PROBE'));
    await assert.rejects(resume, 'the cooperative child invocation stopped');
    const before = await service.readThreadState(setup());
    assert.equal(before.pendingInterrupt?.interruptId, pending.interruptId, 'fixture hits stale parent projection');
    const savedCounts = { ...counts };
    await service.finishStoppedRun(setup(control.signal));
    const after = await service.readThreadState(setup());
    assert.equal(after.pendingInterrupt, null);
    assert.equal(after.acceptsResume, false);
    assert.deepEqual(after.messages, before.messages, 'saved context is unchanged');
    assert.deepEqual(after.currentPlan, before.currentPlan, 'continue plan is unchanged');
    assert.deepEqual(counts, savedCounts, 'stop performs no model, policy or tool execution');
    await assert.rejects(invoke({ kind: 'resume', requestId: 'old-cancel', resume: {
      interruptId: pending.interruptId, value: { action: 'cancel' },
    } }, setup()));
    assert.deepEqual(counts, savedCounts, 'old cancel cannot re-enter child');
    await invoke({ kind: 'user_message', requestId: 'next-input', message: 'Continue work.' }, setup());
    assert.equal(counts.entry, savedCounts.entry + 1);
    assert.equal(counts.model, savedCounts.model);
    assert.equal(counts.tools, savedCounts.tools);
  });
}
