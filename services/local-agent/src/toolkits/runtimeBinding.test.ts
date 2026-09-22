import assert from 'node:assert/strict';
import test from 'node:test';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createSubagent, defineToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { bindToolkitRuntime, type ConnectedToolkitRuntime } from './runtimeBinding';

const binding = (client: unknown): ConnectedToolkitRuntime => ({
  runtimeKind: 'shell', client,
});

test('Host binds a shared static Tool independently and overrides untrusted invocation bindings', async () => {
  const seen: unknown[] = [];
  const action = tool(async (_input, config) => {
    await Promise.resolve();
    const context = config.context as { toolkitRuntime: unknown; marker: string };
    seen.push([context.toolkitRuntime, context.marker]);
    return 'done';
  }, { name: 'action', description: 'Act.', schema: z.object({}) });
  const first = {}, second = {};
  const requirements = ['first', 'second'].map(name => ({ runtimeKind: 'shell', toolkit: defineToolkit({
    name, description: name, tools: [{ tool: action }],
  }) }));
  const assembled = requirements.map((requirement, index) => bindToolkitRuntime(requirement, binding([first, second][index])));
  await Promise.all(assembled.map(({ tools }) => tools[0].tool.invoke({}, { context: {
    toolkitRuntime: {}, marker: 'preserved',
  } })));
  assert.deepEqual(seen, [[first, 'preserved'], [second, 'preserved']]);
  assert.equal('runtime' in assembled[0], false);
  assert.strictEqual(assembled[0].tools[0].tool.schema, action.schema);
  assert.strictEqual(requirements[0].toolkit.tools[0].tool.schema, action.schema);
  assert.throws(() => bindToolkitRuntime({ ...requirements[0], runtimeKind: '' }), /non-empty Runtime/);
  assert.throws(() => bindToolkitRuntime(requirements[0]), /requires a connected/);
  assert.throws(() => bindToolkitRuntime(requirements[0], { ...binding(first), runtimeKind: 'cdp' }), /requires a connected/);
});

test('Host binding retains native Tool events, Command results and graph invocation scope', async () => {
  const events: string[] = [];
  const client = {};
  const action = tool((_input, config) => {
    const context = config.context as { toolkitRuntime: unknown; executionScope: { delegationId: string } };
    assert.strictEqual(context.toolkitRuntime, client);
    assert.equal(context.executionScope.delegationId, 'delegation');
    return new Command({ update: { messages: [
      new ToolMessage({ name: 'action', tool_call_id: (config as ToolRuntime).toolCallId!, content: 'completed' }),
      new AIMessage('Tool-owned result'),
    ] } });
  }, { name: 'action', description: 'Act.', schema: z.object({}) });
  const toolkit = bindToolkitRuntime({ runtimeKind: 'shell', toolkit: defineToolkit({
    name: 'example', description: 'Example', tools: [{ tool: action }],
  }) }, binding(client));
  const result = await createSubagent({
    model: new (class extends BaseChatModel {
      _llmType() { return 'host-binding-test'; }
      bindTools() { return this; }
      async _generate(messages: import('@langchain/core/messages').BaseMessage[]) {
        const message = messages.some(ToolMessage.isInstance) ? new AIMessage('done')
          : new AIMessage({ content: '', tool_calls: [{ id: 'call', name: 'action', args: {} }] });
        return { generations: [{ message, text: message.text }] };
      }
    })({}),
    promptSections: [],
    tools: toolkit.tools.map(({ tool }) => tool), messages: [new HumanMessage('Execute')],
    runtimeContext: { executionScope: { threadId: 'thread', taskId: 'task', runId: 'run', delegationId: 'delegation' } },
    runnableConfig: { callbacks: [{ handleToolStart() { events.push('start'); }, handleToolEnd() { events.push('end'); } }] },
  });
  assert.deepEqual(events, ['start', 'end']);
  assert.ok(result.messages.some(message => ToolMessage.isInstance(message) && message.tool_call_id === 'call' && message.content === 'completed'));
  assert.ok(result.messages.some(message => message.content === 'Tool-owned result'));
});
