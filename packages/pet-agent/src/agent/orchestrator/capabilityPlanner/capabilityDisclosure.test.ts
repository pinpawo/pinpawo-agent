import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCapabilitySearchObservations,
  createCapabilityDisclosureState,
  removeSearchedCapabilities,
  resolveCapabilityDisclosureState,
} from './capabilityDisclosure';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';

function workspace(
  registryDigest = 'a'.repeat(64),
): CapabilityDocumentWorkspace {
  const capabilityNames = ['general', 'explore', 'writer'];
  return {
    rootPath: '/tmp/capabilities',
    registryDigest,
    capabilityNames,
    entries: capabilityNames.map((capabilityName) => ({
      capabilityName,
      description: `${capabilityName} capability`,
      relativePath: `${capabilityName}/CAPABILITY.md`,
      documentDigest: capabilityName.repeat(8),
      provenance: 'authored',
    })),
    reused: false,
  };
}

test('Capability disclosure starts empty and persists discoveries in order', () => {
  const initial = createCapabilityDisclosureState({
    workspace: workspace(),
    maxEmptySearchRounds: 2,
  });
  const afterEntry = applyCapabilitySearchObservations(initial, [{
    modelMessageId: 'entry-round-1',
    toolCallId: 'entry-search',
    disclosedCapabilityNames: ['explore'],
  }]);
  const afterBoundary = applyCapabilitySearchObservations(afterEntry, [{
    modelMessageId: 'boundary-round-1',
    toolCallId: 'boundary-search',
    disclosedCapabilityNames: ['writer', 'explore'],
  }]);

  assert.deepEqual(afterBoundary.disclosedCapabilityNames, [
    'explore',
    'writer',
  ]);
  assert.equal(afterBoundary.emptySearchRounds, 0);
  assert.equal(afterBoundary.status, 'open');
});

test('Capability disclosure counts a wholly empty parallel batch once', () => {
  const initial = createCapabilityDisclosureState({
    workspace: workspace(),
    maxEmptySearchRounds: 2,
  });
  const afterFirstBoundary = applyCapabilitySearchObservations(initial, [{
    modelMessageId: 'round-1',
    toolCallId: 'search-1',
    disclosedCapabilityNames: [],
  }, {
    modelMessageId: 'round-1',
    toolCallId: 'search-2',
    disclosedCapabilityNames: [],
  }]);
  const closed = applyCapabilitySearchObservations(afterFirstBoundary, [{
    modelMessageId: 'round-2',
    toolCallId: 'search-3',
    disclosedCapabilityNames: [],
  }]);

  assert.equal(afterFirstBoundary.emptySearchRounds, 1);
  assert.equal(afterFirstBoundary.status, 'open');
  assert.equal(closed.emptySearchRounds, 2);
  assert.equal(closed.status, 'closed');
});

test('Capability disclosure resets when the registry generation changes', () => {
  const firstWorkspace = workspace('a'.repeat(64));
  const current = {
    ...createCapabilityDisclosureState({
      workspace: firstWorkspace,
      maxEmptySearchRounds: 2,
    }),
    disclosedCapabilityNames: ['general', 'explore'],
    emptySearchRounds: 2,
    status: 'closed' as const,
  };
  const nextWorkspace = workspace('b'.repeat(64));

  assert.deepEqual(resolveCapabilityDisclosureState({
    current,
    workspace: nextWorkspace,
    maxEmptySearchRounds: 3,
  }), {
    registryDigest: nextWorkspace.registryDigest,
    disclosedCapabilityNames: [],
    emptySearchRounds: 0,
    maxEmptySearchRounds: 3,
    status: 'open',
  });
});

test('Capability disclosure can discard searched Capabilities without reopening discovery', () => {
  const current = {
    ...createCapabilityDisclosureState({
      workspace: workspace(),
      maxEmptySearchRounds: 2,
    }),
    disclosedCapabilityNames: ['general', 'explore', 'writer'],
    emptySearchRounds: 2,
    status: 'closed' as const,
  };

  assert.deepEqual(removeSearchedCapabilities({
    current,
  }), {
    ...current,
    disclosedCapabilityNames: [],
  });
});
