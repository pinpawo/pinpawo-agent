import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { DelegationAnnounceMessage } from '../delegation';
import { projectCapabilityPlannerMessagesForModel } from './providerMessages';

test('Planner provider input projects typed Announces without mutating canonical messages', () => {
  const request = new HumanMessage('检查代码并继续。');
  const accepted = new DelegationAnnounceMessage({
    id: 'accepted-1',
    sourceLane: 'capability:explore',
    delegationId: 'delegation-accepted',
    runId: 'run-old',
    announceMessageId: 'announce-old',
    task: '检查历史实现',
    completionReason: 'natural',
    result: '历史实现已检查。',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const projected = projectCapabilityPlannerMessagesForModel([
    request,
    accepted,
  ]);

  assert.equal(projected.length, 2);
  assert.equal(projected[0], request);
  assert.notEqual(projected[1], accepted);
  assert.match(projected[1]?.text ?? '', /<delegation_announce/);
  assert.match(projected[1]?.text ?? '', /历史实现已检查/);
  assert.match(accepted.text, /历史实现已检查/);
});
