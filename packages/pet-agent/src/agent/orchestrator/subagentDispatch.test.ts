import assert from 'node:assert/strict';
import test from 'node:test';
import { getAgentMessageMetadata } from '../messages';
import {
  buildCapabilityRuntimeContextMessage,
  CAPABILITY_RUNTIME_CONTEXT_MESSAGE_NAME,
} from './subagentDispatch';

test('Capability runtime facts form one non-authoritative invocation message', () => {
  const message = buildCapabilityRuntimeContextMessage({
    workdir: '/workspace/project',
    runtimeEnvironment: 'Linux container',
    artifactDiscovery: true,
  });

  assert.ok(message);
  assert.equal(message._getType(), 'human');
  assert.equal(message.name, CAPABILITY_RUNTIME_CONTEXT_MESSAGE_NAME);
  assert.match(message.text, /<capability_runtime_context[^>]*authority="none"/);
  assert.match(message.text, /<workdir[^>]*>[\s\S]*\/workspace\/project/);
  assert.match(message.text, /<runtime_environment>[\s\S]*Linux container/);
  assert.match(message.text, /<available_interface name="artifact_discovery"/);
  assert.deepEqual(getAgentMessageMetadata(message), {
    source: CAPABILITY_RUNTIME_CONTEXT_MESSAGE_NAME,
    synthetic: true,
    invocationOnly: true,
    authority: 'none',
  });
});

test('Capability runtime context is absent when no runtime fact applies', () => {
  assert.equal(buildCapabilityRuntimeContextMessage({
    artifactDiscovery: false,
  }), null);
});
