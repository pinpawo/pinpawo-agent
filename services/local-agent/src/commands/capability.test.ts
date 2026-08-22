import assert from 'node:assert/strict';
import test from 'node:test';
import { assertChatCapabilityInstallable } from './capability';

test('Chat Capability installation rejects every Host-owned name', () => {
  for (const name of ['general', 'explore', 'capability_creator', 'browser']) {
    assert.throws(
      () => assertChatCapabilityInstallable(name),
      new RegExp(`Capability "${name}" conflicts with a Chat Host Capability`),
    );
  }
});

test('Chat Capability installation accepts an external Capability name', () => {
  assert.doesNotThrow(() => assertChatCapabilityInstallable('document_writer'));
});
