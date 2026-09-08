import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCapabilityDisclosure,
  createCapabilityDisclosureState,
  resolveCapabilityDisclosureState,
} from './capabilityDisclosure';
import type { CapabilityCatalog } from './capabilityCatalog';

function catalog(
  registryDigest = 'a'.repeat(64),
): CapabilityCatalog {
  const capabilityNames = ['general', 'explore', 'writer'];
  return {
    registryDigest,
    capabilityNames,
    entries: capabilityNames.map((capabilityName) => ({
      capabilityName,
      description: `${capabilityName} capability`,
      toolkits: [],
      content: capabilityName,
    })),
  };
}

test('disclosure merges names idempotently and keeps their order', () => {
  const initial = createCapabilityDisclosureState({ catalog: catalog(), seedCapabilityNames: ['general', 'missing', 'general'] });
  const next = mergeCapabilityDisclosure(initial, ['explore', 'writer', 'explore']);
  assert.deepEqual(next, { registryDigest: initial.registryDigest, disclosedCapabilityNames: ['general', 'explore', 'writer'] });
  assert.deepEqual(mergeCapabilityDisclosure(next, []), next);
  assert.deepEqual(mergeCapabilityDisclosure(next, ['explore']), next);
});

test('disclosure resets only on a new registry generation', () => {
  const current = createCapabilityDisclosureState({ catalog: catalog(), seedCapabilityNames: ['general'] });
  assert.equal(resolveCapabilityDisclosureState({ current, catalog: catalog() }), current);
  assert.deepEqual(resolveCapabilityDisclosureState({ current, catalog: catalog('b'.repeat(64)) }), {
    registryDigest: 'b'.repeat(64), disclosedCapabilityNames: [],
  });
});
