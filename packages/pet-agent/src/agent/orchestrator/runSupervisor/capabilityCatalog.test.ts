import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineInstructionDocument, type AgentCapability } from '../../../types/capability';
import { compileAgentRegistry } from '../registry';
import { createCapabilityCatalog } from './capabilityCatalog';
import { createCapabilityRoutingManifest } from './routingManifest';
import { createSupervisorDocumentReader, SupervisorDocumentError } from './capabilityDocuments';

function capability(name: string, content = name): AgentCapability {
  return { name, description: `${name} responsibility`, uses: [], instructions: defineInstructionDocument({ content }) };
}

function catalog(...capabilities: AgentCapability[]) {
  return createCapabilityCatalog({ registry: compileAgentRegistry({ toolkits: [], capabilities }) });
}

test('catalog isolates Host-allowed capabilities and preserves authored documents without filesystem access', () => {
  const content = '---\nname: general\ndescription: general responsibility\nuses: []\nversion: 1\n---\n\nOriginal instructions.\n';
  const authored = { ...capability('general', 'Original instructions.'), document: {
    kind: 'file' as const, filePath: '/nonexistent/CAPABILITY.md', content,
    digest: createHash('sha256').update(content).digest('hex'),
  } };
  const registry = compileAgentRegistry({ toolkits: [], capabilities: [authored, capability('private')] });
  const visible = createCapabilityCatalog({ registry, allowedCapabilityNames: ['general'] });
  assert.deepEqual(visible.capabilityNames, ['general']);
  assert.equal(visible.entries[0].content, content);
  assert.equal(Object.isFrozen(visible.entries), true);
  assert.equal(Object.isFrozen(visible.entries[0]), true);
  assert.throws(() => createSupervisorDocumentReader(visible).readCapabilities(['private']),
    (error: unknown) => error instanceof SupervisorDocumentError && error.code === 'document_not_found');
  assert.deepEqual(createCapabilityCatalog({ registry, allowedCapabilityNames: [] }).entries, []);
  for (const allowedCapabilityNames of [['general', 'general'], ['../general']]) {
    assert.throws(() => createCapabilityCatalog({ registry, allowedCapabilityNames }));
  }
});

test('catalog identity is independent of input order and changes with exposed content', () => {
  const first = catalog(capability('general'), capability('explore'));
  const reordered = catalog(capability('explore'), capability('general'));
  assert.equal(first.registryDigest, reordered.registryDigest);
  assert.notEqual(first.registryDigest, catalog(capability('general', 'Updated instructions.'), capability('explore')).registryDigest);
});

test('routing uses authored responsibility and compiled Toolkit descriptions directly', () => {
  const registry = compileAgentRegistry({
    capabilities: [{ ...capability('general'), uses: ['files'] }],
    toolkits: [{ name: 'files', description: 'Registered file operations.', tools: [{ tool: tool(() => 'ok', { name: 'read_file', description: 'Read a file.', schema: z.object({}) }) }] }],
  });
  const visible = createCapabilityCatalog({ registry });
  const manifest = createCapabilityRoutingManifest({ catalog: visible });
  assert.equal(manifest.defaultCapabilityName, 'general');
  assert.equal(manifest.capabilities[0].purpose, visible.entries[0].description);
  assert.deepEqual(manifest.capabilities[0].toolkits, [{ name: 'files', description: 'Registered file operations.' }]);
  assert.equal(createCapabilityRoutingManifest({ catalog: visible, defaultCapabilityName: 'missing' }).defaultCapabilityName, undefined);
});

test('document accounting is isolated per invocation and never truncates a document to fit', () => {
  const visible = catalog(capability('general'), capability('explore'));
  const entry = visible.entries.find(({ capabilityName }) => capabilityName === 'general')!;
  const bytes = Buffer.byteLength(entry.content, 'utf8');
  const reader = createSupervisorDocumentReader(visible, bytes);
  assert.deepEqual(reader.readCapabilities(['general', 'general']), [{ capabilityName: 'general', content: entry.content }]);
  assert.throws(() => reader.readCapabilities(['explore']),
    (error: unknown) => error instanceof SupervisorDocumentError && error.code === 'supervisor_discovery_limit_reached');
  assert.throws(() => reader.assertWithinBudget(), SupervisorDocumentError);
  assert.equal(createSupervisorDocumentReader(visible, bytes).readCapabilities(['general'])[0].content, entry.content);
});

test('document reads preserve the caller cancellation reason', () => {
  const reason = new Error('Cancelled by caller');
  const reader = createSupervisorDocumentReader(catalog(capability('general')));
  assert.throws(() => reader.readCapabilities(['general'], AbortSignal.abort(reason)), (error) => error === reason);
});
