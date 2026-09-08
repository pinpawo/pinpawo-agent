import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCapabilityDisclosure,
  createCapabilityDisclosureState,
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
      toolkits: [],
      relativePath: `${capabilityName}/CAPABILITY.md`,
      documentDigest: capabilityName.repeat(8),
      provenance: 'authored',
    })),
    reused: false,
  };
}

test('disclosure merges names idempotently and keeps their order', () => {
  const initial = createCapabilityDisclosureState({ workspace: workspace(), seedCapabilityNames: ['general', 'missing', 'general'] });
  const next = mergeCapabilityDisclosure(initial, ['explore', 'writer', 'explore']);
  assert.deepEqual(next, { registryDigest: initial.registryDigest, disclosedCapabilityNames: ['general', 'explore', 'writer'] });
  assert.deepEqual(mergeCapabilityDisclosure(next, []), next);
  assert.deepEqual(mergeCapabilityDisclosure(next, ['explore']), next);
});

test('disclosure resets only on a new registry generation', () => {
  const current = createCapabilityDisclosureState({ workspace: workspace(), seedCapabilityNames: ['general'] });
  assert.equal(resolveCapabilityDisclosureState({ current, workspace: workspace() }), current);
  assert.deepEqual(resolveCapabilityDisclosureState({ current, workspace: workspace('b'.repeat(64)) }), {
    registryDigest: 'b'.repeat(64), disclosedCapabilityNames: [],
  });
});
