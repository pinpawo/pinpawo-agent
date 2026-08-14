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
    capabilityId: 'content_writer',
    delegationId: 'delegation-1',
    runId: 'turn-1',
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
      id: 'report-old',
      capabilityId: 'content_writer',
      delegationId: 'delegation-old',
      schema: { name: 'ContentWriterResult', version: 1 },
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
      id: 'report-new',
      capabilityId: 'content_writer',
      delegationId: 'delegation-new',
      schema: { name: 'ContentWriterResult', version: 1 },
      createdAt: '2026-06-19T00:05:00.000Z',
    }),
  ];

  assert.equal(
    selectCapabilityResultArtifact(artifacts, {
      capabilityId: 'content_writer',
      schemaName: 'ContentWriterResult',
    })?.id,
    'report-new',
  );
  assert.equal(
    selectCapabilityResultArtifact(artifacts, { delegationId: 'delegation-old' })?.id,
    'report-old',
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
      capabilityId: 'content_writer',
      kind: 'result',
      metadata: { role: 'audit' },
    }).map((artifact) => artifact.id),
    ['audit'],
  );
});
