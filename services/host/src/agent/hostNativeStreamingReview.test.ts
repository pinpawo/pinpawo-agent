import { createServer } from 'node:http';
import { buildHostModels } from './agentModels';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { buildReviewSpec, compileAgentRegistry, defineInstructionDocument, type AgentModels } from '@pinpawo/pet-agent';
import { withScriptedDelegation } from '../../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { FileSaver } from '../fileSaver';
import { HostGraphService } from './agentGraphService';
import { runAgentSessionTurn } from './chatSessionAdapter';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { AgentChannelSetup } from './agentChannel';

for (const decision of ['respond', 'reject'] as const) {
  test(`Host v3 uses native ChatOpenAI streaming with localhost SSE and restores ${decision} via FileSaver (#1029)`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-host-stream-review-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'checkpoints.json');
    let calls = 0;
    let toolRuns = 0;
    let supervisorCalls = 0;
    const requests: Array<{ stream: boolean; messages: Array<Record<string, unknown>> }> = [];
    const paths: Array<string | undefined> = [];
    const deltas = [
      { role: 'assistant', reasoning_content: 'PRIVATE-' }, { reasoning_content: 'THOUGHT' },
      { content: 'Visible ' }, { content: 'text.' },
      { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'reviewed_action', arguments: '{"value":"' } }] },
      { tool_calls: [{ index: 0, function: { arguments: 'original"}' } }] },
    ];
    const server = createServer((request, response) => {
      calls++;
      paths.push(request.url);
      let body = ''; request.on('data', chunk => body += chunk);
      request.on('end', () => {
        const parsed = JSON.parse(body); requests.push(parsed);

        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const output = calls === 1 ? deltas : [{ role: 'assistant', content: 'Finished.' }];
        for (const delta of output) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'glm-4.5', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'glm-4.5', choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const model = buildHostModels({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'glm-4.5', modelProfileId: 'fixture', contextWindowTokens: 32000 }).subagent;
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
    const observed: AgentRuntimeEvent[] = [];
    const initial = await runAgentSessionTurn({
      request: { kind: 'user_message', requestId: 'first', message: 'Inspect.' },
      setup: makeSetup(), graphService: new HostGraphService(), isCurrent: () => true,
      emitEvent: (event) => observed.push(event), emitToolEvent: () => {},
    });
    assert.deepEqual(initial, { status: 'waiting' });
    const restartedService = new HostGraphService();
    const restartedSetup = makeSetup();
    const pending = (await restartedService.readThreadState(restartedSetup)).pendingInterrupt;
    assert.ok(pending);
    const reviewId = pending.payload.reviews[0]?.id;
    assert.ok(reviewId);
    assert.equal(calls, 1);
    assert.equal(toolRuns, 0);
    await runAgentSessionTurn({
      request: { kind: 'resume', requestId: 'second', resume: {
        interruptId: pending.interruptId, value: { decisions: [{
          reviewId, selectedOptionId: decision, ...(decision === 'respond' ? { input: { message: 'Use read-only.' } } : {}),
        }] },
      } },
      setup: restartedSetup, graphService: restartedService, isCurrent: () => true,
      emitEvent: (event) => observed.push(event), emitToolEvent: () => {},
    });
    assert.equal(toolRuns, 0);
    assert.equal(calls, decision === 'respond' ? 2 : 1);
    if (decision === 'respond') {
      const messages = requests.at(-1)?.messages ?? [];
      const action = messages.find(item => item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.some(call => call.id === 'call-1'));
      const result = messages.find(item => item.role === 'tool' && item.tool_call_id === 'call-1');
      assert.ok(action);
      assert.deepEqual(action.content, [{ type: 'text', text: 'Visible text.' }]);
      assert.equal(action.reasoning_content, 'PRIVATE-THOUGHT');
      assert.deepEqual(action.tool_calls, [{ id: 'call-1', type: 'function',
        function: { name: 'reviewed_action', arguments: '{"value":"original"}' } }]);
      assert.ok(result);
      assert.match(String(result.content), /Use read-only/);

    }
    assert.ok(requests.every((request) => request.stream === true));
    assert.ok(paths.every((path) => path === '/v1/chat/completions'));
    assert.ok(observed.some((item) => item.type === 'subagent.message.completed' && item.text === 'Visible text.'));
    const publicEvents = JSON.stringify(observed);
    assert.ok(!publicEvents.includes('PRIVATE-') && !publicEvents.includes('THOUGHT'),
      'Agent Session events must not expose any reasoning fragment');
  });
}
