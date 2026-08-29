import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { setAgentMessageDelegationScope, setAgentMessageMetadata } from '../messages';
import { createOrchestratorMessageViews } from './messageViews';

const scope = {
  lane: 'capability:general' as const,
  transcriptRunId: 'run-1',
  delegationId: 'delegation-1',
};

test('Planner Boundary convenience view partitions main and current announce evidence', () => {
  const main = new HumanMessage({ id: 'main', content: 'goal' });
  const announce = setAgentMessageMetadata(setAgentMessageDelegationScope(
    new AIMessage({ id: 'announce', content: 'result' }),
    scope,
  ), { isAnnounce: true });
  const raw = setAgentMessageDelegationScope(
    new AIMessage({ id: 'raw', content: 'private' }),
    scope,
  );

  const view = createOrchestratorMessageViews([main, raw, announce])
    .capabilityPlannerBoundary(scope);

  assert.deepEqual(view.messagesBySource.main, [main]);
  assert.deepEqual(view.messagesBySource.delegation, [announce]);
  assert.equal(view.manifest.excludedItems.find((item) => item.messageId === 'raw')?.reason,
    'not_announce');
});

test('Planner provider convenience view owns the invocation overlay', () => {
  const main = new HumanMessage({ id: 'main', content: 'goal' });
  const plannerInput = new HumanMessage({ id: 'planner-input', content: 'boundary' });

  const view = createOrchestratorMessageViews([main])
    .capabilityPlannerProvider(plannerInput);

  assert.deepEqual(view.messages, [main, plannerInput]);
  assert.deepEqual(view.messagesBySource.planner_input, [plannerInput]);
  assert.deepEqual(view.manifest.items.map((item) => item.sourceId), [
    'main',
    'planner_input',
  ]);
});
