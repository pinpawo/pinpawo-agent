import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapabilityArtifactRef } from '../../types/artifact';
import {
  filterCapabilityArtifacts,
  selectCapabilityResultArtifact,
} from './capabilityArtifacts';

function ref(overrides: Partial<CapabilityArtifactRef> & { id: string }): CapabilityArtifactRef {
  const { id, ...rest } = overrides;
  return {
    id,
    threadId: 'thread-1',
    capabilityId: 'daily_post',
    delegationId: 'delegation-1',
    turnId: 'turn-1',
    kind: 'result',
    mimeType: 'application/json',
    uri: `capability-artifact://thread/thread-1/delegation/delegation-1/artifact/${id}`,
    sizeBytes: 10,
    createdAt: '2026-06-19T00:00:00.000Z',
    ...rest,
  };
}

test('selectCapabilityResultArtifact requires explicit scope', () => {
  assert.throws(
    () => selectCapabilityResultArtifact([ref({ id: 'result-1' })], {}),
    /no global latest result/,
  );
});

test('selectCapabilityResultArtifact selects latest result only within the requested scope', () => {
  const artifacts = [
    ref({
      id: 'daily-old',
      capabilityId: 'daily_post',
      delegationId: 'delegation-old',
      schema: { name: 'DailyPostResult', version: 1 },
      createdAt: '2026-06-19T00:00:00.000Z',
    }),
    ref({
      id: 'creator-newer',
      capabilityId: 'capability_creator',
      delegationId: 'delegation-creator',
      schema: { name: 'CapabilityCreatorResult', version: 1 },
      createdAt: '2026-06-19T00:10:00.000Z',
    }),
    ref({
      id: 'daily-new',
      capabilityId: 'daily_post',
      delegationId: 'delegation-new',
      schema: { name: 'DailyPostResult', version: 1 },
      createdAt: '2026-06-19T00:05:00.000Z',
    }),
  ];

  assert.equal(
    selectCapabilityResultArtifact(artifacts, {
      capabilityId: 'daily_post',
      schemaName: 'DailyPostResult',
    })?.id,
    'daily-new',
  );
  assert.equal(
    selectCapabilityResultArtifact(artifacts, { delegationId: 'delegation-old' })?.id,
    'daily-old',
  );
});

test('artifact selectors can distinguish multiple result roles from one capability run', () => {
  const artifacts = [
    ref({ id: 'summary', metadata: { role: 'summary' } }),
    ref({ id: 'audit', metadata: { role: 'audit' } }),
    ref({ id: 'report', kind: 'report', metadata: { role: 'audit' } }),
  ];

  assert.deepEqual(
    filterCapabilityArtifacts(artifacts, {
      capabilityId: 'daily_post',
      kind: 'result',
      metadata: { role: 'audit' },
    }).map((artifact) => artifact.id),
    ['audit'],
  );
});
