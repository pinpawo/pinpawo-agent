import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DelegationAnnounceMessage } from '../delegationAnnounce';
import { setPinpetMeta } from '../messageLanes';
import { projectCapabilityPlannerMessagesForModel } from './messageContext';

test('Planner context contains only clean canonical conversation with ephemeral announce projection', () => {
  const request = new HumanMessage('检查代码并继续。');
  const privateLane = new AIMessage('PRIVATE_EXECUTOR_TRANSCRIPT');
  setPinpetMeta(privateLane, {
    lane: 'capability:general',
    runId: 'transcript-1',
    delegationId: 'delegation-1',
  });
  const legacyPlannerLane = new AIMessage('LEGACY_PLANNER_TRANSCRIPT');
  setPinpetMeta(legacyPlannerLane, {
    lane: 'orchestrator',
    source: 'capability_planner',
  });
  const accepted = new DelegationAnnounceMessage({
    id: 'accepted-1',
    sourceLane: 'capability:explore',
    delegationId: 'delegation-accepted',
    transcriptRunId: 'run-old',
    announceMessageId: 'announce-old',
    task: '检查历史实现',
    completionReason: 'natural',
    result: '历史实现已检查。',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const projected = projectCapabilityPlannerMessagesForModel([
    request,
    privateLane,
    legacyPlannerLane,
    accepted,
  ]);

  assert.equal(projected.length, 2);
  assert.equal(projected[0], request);
  assert.notEqual(projected[1], accepted);
  assert.match(projected[1]?.text ?? '', /<delegation_announce/);
  assert.match(projected[1]?.text ?? '', /历史实现已检查/);
  assert.equal(projected.some((message) => message.text.includes('PRIVATE_EXECUTOR_TRANSCRIPT')), false);
  assert.equal(projected.some((message) => message.text.includes('LEGACY_PLANNER_TRANSCRIPT')), false);
});
