import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import { setAgentMessageMetadata } from '../messages';
import { createCapabilityExecutionMessage } from './executionMessages';
import { readReplyDeliverables, selectReplyDeliverables } from './replyDeliverables';
import type { RunSupervisorState } from './runSupervisor/state';
import { createEntryAnswerSubgraph } from './runtime/nodes/entryAnswer';
import { createRunSupervisorNode } from './runtime/nodes/runSupervisor';
import { createOrchestratorGraph } from './runtime/graph';
import { buildOrchestratorRunInput, type OrchestratorStateType } from './state';
import { compileAgentRegistry } from './registry';
import { defineToolkit } from '../../types/toolkit';
import { defineInstructionDocument } from '../../types/capability';
import { withScriptedDelegation } from './runSupervisor/testing';
import { readCapabilityExecutions } from './executionMessages';

function execution(id: string, planItemId: string, uri: string, runId = 'run'): BaseMessage[] {
  const metadata = { runId, taskId: 'task' };
  return [setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{ id, name: 'delegate_capability', args: {} }] }), metadata),
    createCapabilityExecutionMessage({ callId: id, metadata,
      execution: { planItemId, delegationId: id, capability: 'general', task: 'Write report', briefing: 'Prepare it' },
      result: { status: 'returned', deliverables: [{ uri }], delivery: { id: `delivery:${id}`, task: 'Write report', text: 'Ready',
        scope: { lane: 'capability:general', runId, taskId: 'task', delegationId: id } } },
    })];
}

test('reply selects only latest accepted executions from its own run and deduplicates in publication order', () => {
  const plan: RunSupervisorState = { runId: 'run', goal: 'Reports', plan: [
    { id: 'a', capability: 'general', objective: 'A', status: 'completed' },
    { id: 'b', capability: 'general', objective: 'B', status: 'pending' },
    { id: 'c', capability: 'general', objective: 'C', status: 'superseded' },
    { id: 'd', capability: 'general', objective: 'D', status: 'completed' },
  ] };
  const messages = [
    ...execution('previous', 'a', 'artifact://old/report', 'old-run'),
    ...execution('rejected-attempt', 'a', 'artifact://unaccepted/report'),
    ...execution('accepted-attempt', 'a', 'artifact://accepted/report'),
    ...execution('pending', 'b', 'artifact://pending/report'),
    ...execution('superseded', 'c', 'artifact://superseded/report'),
    ...execution('duplicate', 'd', 'artifact://accepted/report'),
  ];
  assert.deepEqual(selectReplyDeliverables(messages, plan, 'run'), [{ uri: 'artifact://accepted/report' }]);
  assert.deepEqual(selectReplyDeliverables(messages, plan, 'new-run'), []);
  const reply = new AIMessage({ content: 'Done', additional_kwargs: { deliverables: selectReplyDeliverables(messages, plan, 'run') } });
  assert.deepEqual(readReplyDeliverables(reply), [{ uri: 'artifact://accepted/report' }]);
  assert.deepEqual(readReplyDeliverables(undefined), []);
  assert.deepEqual(readReplyDeliverables(new AIMessage('https://example.com/undeclared')), []);
  assert.throws(() => readReplyDeliverables(new AIMessage({ content: 'Invalid', additional_kwargs: { deliverables: [{}] } })), /Invalid deliverables/);
});

test('Entry commits selected references on the final reply and ignores model-authored declarations', async () => {
  const model = { bindTools: () => ({ invoke: async () => new AIMessage({ content: 'Done',
    additional_kwargs: { deliverables: [{ uri: 'https://example.com/model-invention' }], provider: 'retained' },
  }) }) } as unknown as BaseChatModel;
  const graph = createEntryAnswerSubgraph({ models: { act: model } });
  const plan: RunSupervisorState = { runId: 'run', goal: 'Report', plan: [
    { id: 'report', capability: 'general', objective: 'Report', status: 'completed' },
  ] };
  for (const runId of ['run', 'next-run']) {
    const result = await graph.invoke({ runId, messages: [new HumanMessage('Report'), ...execution('accepted', 'report', 'artifact://thread/report')],
      runSupervisorState: plan });
    const reply = result.messages.at(-1)!;
    assert.equal(reply.additional_kwargs.provider, 'retained');
    assert.deepEqual(readReplyDeliverables(reply), runId === 'run' ? [{ uri: 'artifact://thread/report' }] : []);
  }
});

test('delegated execution delivers accepted references through the Supervisor final reply and budget exit', async () => {
  const uris = ['artifact://thread/rejected/report', 'artifact://thread/accepted/report'];
  let published = 0;
  const toolkit = defineToolkit({ name: 'artifacts', description: 'Publish files.', tools: [{ tool: tool(
    async () => ['Published', { deliverables: [{ uri: uris[published++] }] }],
    { name: 'publish_artifact', description: 'Publish.', schema: z.object({}), responseFormat: 'content_and_artifact' },
  ) }] });
  const registry = compileAgentRegistry({ toolkits: [toolkit], capabilities: [{ name: 'general',
    description: 'Prepare reports.', uses: ['artifacts'], instructions: defineInstructionDocument({ content: 'Prepare and publish the report.' }),
  }] });
  const entryModel = { bindTools: () => ({ invoke: async () => new AIMessage({ content: 'Prepare report',
    tool_calls: [{ id: 'route', name: 'plan_request', args: { goal: 'Prepare report' } }],
  }) }) } as unknown as BaseChatModel;
  const subagent = new FakeToolCallingModel({ toolCalls: [[{ id: 'publish', name: 'publish_artifact', args: {} }], []] });
  let reviews = 0;
  const graph = createOrchestratorGraph({ models: { act: entryModel, subagent },
    runSupervisorRunner: withScriptedDelegation({ invoke: async input => input.mode === 'entry'
      ? { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Prepare report' }] } }
      : { name: 'review_current', args: ++reviews === 1
        ? { completed: false, reason: 'The first report needs rework.' }
        : { completed: true, reason: 'The revised report is ready.', reply: 'Report complete.' } },
    }),
  });
  const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('Prepare report')]), { configurable: { registry } });
  assert.equal(published, 2);
  assert.equal(result.messages.at(-1)?.text, 'Report complete.');
  assert.deepEqual(readCapabilityExecutions(result.messages).map(record => record.result.deliverables),
    uris.map(uri => [{ uri }]));
  assert.deepEqual(readReplyDeliverables(result.messages.at(-1)), [{ uri: uris[1] }]);

  const limitNode = createRunSupervisorNode({ models: { act: entryModel }, runSupervisorRunner: {
    invoke: async () => { throw new Error('Budget stop must not call Supervisor'); },
  } });
  const stopped = await limitNode({ ...result, runIterationCount: 1_000_000 } as OrchestratorStateType);
  const messages = (stopped.update as { messages: BaseMessage[] }).messages;
  assert.deepEqual(readReplyDeliverables(messages.at(-1)), [{ uri: uris[1] }]);
});
