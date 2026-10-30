import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildReviewSpec, compileAgentRegistry, defineInstructionDocument, type AgentModels } from '@pinpawo/pet-agent';
import { withScriptedDelegation } from '../../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { FileSaver } from '../fileSaver';
import { HostGraphService } from './agentGraphService';
import { adaptRootStream } from '../events/rootStreamEventAdapter';
import type { AgentChannelSetup } from './agentChannel';

for (const decision of ['respond', 'reject'] as const) {
  test(`Host v3 streams a reviewed multi-chunk action and restores ${decision} via FileSaver (#1029)`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-host-stream-review-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'checkpoints.json');
    let calls = 0;
    let toolRuns = 0;
    let supervisorCalls = 0;
    const inputs: BaseMessage[][] = [];
    class Model extends BaseChatModel {
      _llmType() { return 'multi-chunk-review-fixture'; }
      bindTools() { return this; }
      async _generate(): Promise<never> { throw new Error('expected model streaming'); }
      async *_streamResponseChunks(messages: BaseMessage[]) {
        inputs.push(messages);
        calls++;
        if (calls > 1) {
          yield new ChatGenerationChunk({ text: 'done', message: new AIMessageChunk({ id: 'final', content: 'done' }) });
          return;
        }
        const chunks = [
          new AIMessageChunk({ id: 'action', content: [{ type: 'reasoning', reasoning: 'PRIVATE-', index: 0 }] }),
          new AIMessageChunk({ id: 'action', content: [{ type: 'reasoning', reasoning: 'THOUGHT', index: 0 }] }),
          new AIMessageChunk({ id: 'action', content: [{ type: 'text', text: 'Visible ', index: 1 }] }),
          new AIMessageChunk({ id: 'action', content: [{ type: 'text', text: 'text.', index: 1 }], tool_call_chunks: [{ id: 'call-1', name: 'reviewed_action', args: '{"value":"', index: 2 }] }),
          new AIMessageChunk({ id: 'action', content: '', tool_call_chunks: [{ args: 'original"}', index: 2 }] }),
        ];
        for (const message of chunks) yield new ChatGenerationChunk({ text: '', message });
      }
    }
    const model = new Model({});
    const rawTool = tool(async () => { toolRuns++; return 'executed'; }, {
      name: 'reviewed_action', description: 'A reviewed action', schema: z.object({ value: z.string() }),
    });
    const registry = compileAgentRegistry({
      capabilities: [{ name: 'general', description: 'General work.', uses: ['local'], instructions: defineInstructionDocument({ content: 'Execute the task.' }) }],
      toolkits: [{ name: 'local', description: 'Local.', tools: [{ tool: rawTool, review: {
        request: () => buildReviewSpec({ view: { kind: 'plain', body: 'Approve?' }, options: [
          { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
          { id: 'reject', label: 'Reject', decision: { type: 'reject', message: 'Do not execute.' } },
          { id: 'respond', label: 'Respond', input: { kind: 'text', key: 'message' }, decision: { type: 'respond', messageInputKey: 'message' } },
        ] }),
      } }] }],
    });
    const entry = { bindTools: () => ({ invoke: async () => new AIMessage({ content: '', tool_calls: [{
      id: 'entry', name: 'plan_request', args: { goal: 'Inspect.' },
    }] }) }) } as unknown as AgentModels['act'];
    const makeSetup = () => ({
      registry,
      graphConfig: {
        models: { act: entry, answer: entry, subagent: model }, checkpoint: new FileSaver(path),
        runSupervisorRunner: withScriptedDelegation({ invoke: async () => {
          supervisorCalls++;
          if (supervisorCalls === 1) return { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Inspect.' }] } };
          return { reply: 'Done.' };
        } }),
      },
      input: { threadId: `host-stream-${decision}`, messages: [new HumanMessage('Inspect.')], globalReviewPolicy: { mode: 'require_authorization' } },
      interfaceContext: { kind: 'tui', threadId: `host-stream-${decision}`, capabilities: { humanReview: true, sessionAuthorization: false } },
    } as AgentChannelSetup);
    const observed: Array<{ type: string; text?: string }> = [];
    const consume = async (service: HostGraphService, setup: AgentChannelSetup, resume?: { interruptId: string; value: unknown }) => {
      const stream = await service.streamEvents(setup, resume);
      for await (const item of adaptRootStream(stream)) {
        if (item.type === 'assistant.delta' || item.type === 'subagent.message') observed.push(item);
      }
      return await stream.output;
    };
    await consume(new HostGraphService(), makeSetup());
    const restartedService = new HostGraphService();
    const restartedSetup = makeSetup();
    const pending = (await restartedService.readThreadState(restartedSetup)).pendingInterrupt;
    assert.ok(pending);
    const reviewId = pending.payload.reviews[0]?.id;
    assert.ok(reviewId);
    assert.equal(calls, 1);
    assert.equal(toolRuns, 0);
    await consume(restartedService, restartedSetup, { interruptId: pending.interruptId, value: { decisions: [{
      reviewId, selectedOptionId: decision, ...(decision === 'respond' ? { input: { message: 'Use read-only.' } } : {}),
    }] } });
    assert.equal(toolRuns, 0);
    assert.equal(calls, decision === 'respond' ? 2 : 1);
    if (decision === 'respond') {
      const next = inputs.at(-1)!;
      const action = next.find((item) => AIMessage.isInstance(item) && item.id === 'action');
      assert.ok(AIMessage.isInstance(action));
      assert.equal(AIMessageChunk.isInstance(action), false);
      assert.equal('tool_call_chunks' in action, false);
      assert.ok(Array.isArray(action.content));
      const blocks = action.content as Array<Record<string, unknown>>;
      assert.deepEqual(blocks.map((block) => block.type), ['reasoning', 'text', 'tool_call']);
      assert.equal(blocks[0].reasoning, 'PRIVATE-THOUGHT');
      assert.equal(blocks[1].text, 'Visible text.');
      assert.deepEqual(action.tool_calls?.map(({ id, name, args }) => ({ id, name, args })), [{ id: 'call-1', name: 'reviewed_action', args: { value: 'original' } }]);
      const result = next.find((item) => ToolMessage.isInstance(item) && item.tool_call_id === 'call-1');
      assert.ok(result, 'the rejected action must have a matching tool result');
      assert.match(String(result.content), /Use read-only/);
    }
    assert.ok(observed.some((item) => item.type === 'subagent.message' && item.text === 'Visible text.'));
    assert.ok(observed.every((item) => !item.text?.includes('PRIVATE-') && !item.text?.includes('THOUGHT')));
  });
}
