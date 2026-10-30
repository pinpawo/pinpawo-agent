import assert from 'node:assert/strict';
import test from 'node:test';
import { compileAgentRegistry } from '@pinpawo/pet-agent';
import { loadChannelContextCapability } from './channelContextCapability';
import { createChannelPlugin } from './channelPlugin';

test('the shared Channel Capability compiles against the Plugin Toolkit without a Pet-local copy', () => {
  const capability = loadChannelContextCapability();
  const plugin = createChannelPlugin({ httpRoute: false });
  assert.equal(capability.name, 'channel_context');
  assert.deepEqual(capability.uses, ['channel']);
  assert.ok(capability.document);
  const registry = compileAgentRegistry({ toolkits: plugin.toolkits, capabilities: plugin.capabilities ?? [] });
  assert.deepEqual(registry.capabilities.map(({ capability: entry }) => entry.name), ['channel_context']);
  assert.deepEqual(registry.unavailableCapabilities, []);
  const missingToolkit = compileAgentRegistry({ toolkits: [], capabilities: [capability] });
  assert.equal(missingToolkit.capabilities.length, 0);
  assert.deepEqual(missingToolkit.unavailableCapabilities[0]?.issues, [{ code: 'unknown_toolkit', toolkitName: 'channel' }]);
});
