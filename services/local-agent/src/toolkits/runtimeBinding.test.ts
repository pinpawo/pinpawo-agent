import assert from 'node:assert/strict';
import test from 'node:test';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createSubagent, defineToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { bindToolkitRuntime, type ToolkitRuntimeClientBinding } from './runtimeBinding';

const binding = (client: unknown): ToolkitRuntimeClientBinding => ({
  runtimeType: 'shell', client, identity: { clientId: 'host', instanceId: 'shell' },
});

test('Host binds a shared static Tool independently and overrides untrusted invocation bindings', async () => {
  const seen: unknown[] = [];
  const action = tool(async (_input, config) => {
    await Promise.resolve();
    const context = config.context as { toolkitName: string; toolkitRuntimes: Record<string, unknown>; marker: string };
    seen.push([context.toolkitName, context.toolkitRuntimes[context.toolkitName], context.marker]);
    return 'done';
  }, { name: 'action', description: 'Act.', schema: z.object({}) });
  const first = {}, second = {};
  const definitions = ['first', 'second'].map(name => ({ runtime: 'shell', ...defineToolkit({
    name, description: name, tools: [{ tool: action }],
  }) }));
  const assembled = definitions.map((definition, index) => bindToolkitRuntime(definition, binding([first, second][index])));
  await Promise.all(assembled.map(({ tools }) => tools[0].tool.invoke({}, { context: {
    toolkitName: 'forged', toolkitRuntimes: { forged: {} }, marker: 'preserved',
  } })));
  assert.deepEqual(seen, [['first', first, 'preserved'], ['second', second, 'preserved']]);
  assert.equal('runtime' in assembled[0], false);
  assert.strictEqual(assembled[0].tools[0].tool.schema, action.schema);
  assert.strictEqual(definitions[0].tools[0].tool.schema, action.schema);
  assert.throws(() => bindToolkitRuntime({ ...definitions[0], runtime: '' }), /non-empty Runtime/);
  assert.throws(() => bindToolkitRuntime(definitions[0]), /requires a connected/);
  assert.throws(() => bindToolkitRuntime(definitions[0], { ...binding(first), runtimeType: 'cdp' }), /requires a connected/);
});

test('Host binding retains native Tool events, Command results and graph invocation scope', async () => {
  const events: string[] = [];
  const client = {};
  const action = tool((_input, config) => {
    const context = config.context as { toolkitRuntimes: Record<string, unknown>; executionScope: { delegationId: string } };
    assert.strictEqual(context.toolkitRuntimes.example, client);
    assert.equal(context.executionScope.delegationId, 'delegation');
    return new Command({ update: { messages: [
      new ToolMessage({ name: 'action', tool_call_id: (config as ToolRuntime).toolCallId!, content: 'completed' }),
      new AIMessage('Tool-owned result'),
    ] } });
  }, { name: 'action', description: 'Act.', schema: z.object({}) });
  const toolkit = bindToolkitRuntime({ runtime: 'shell', ...defineToolkit({
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
