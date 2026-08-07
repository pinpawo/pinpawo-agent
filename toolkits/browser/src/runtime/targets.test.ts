import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedTargetRegistry } from './targets';

test('registry opens a primary agent target and lists it', () => {
  const registry = new ManagedTargetRegistry();
  const target = registry.open({ tabId: 10, ownership: 'agent', url: 'https://example.com/' });

  assert.equal(target.role, 'primary');
  assert.equal(target.state, 'opening');
  assert.equal(target.ownership, 'agent');

  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tabId, 10);

  const active = registry.active();
  assert.equal(active?.tabId, 10);
});

test('registry activates and marks a target open on update', () => {
  const registry = new ManagedTargetRegistry();
  registry.open({ tabId: 10, ownership: 'agent' });

  const updated = registry.applyEvent(registry.byTabId(10)!.targetId, {
    kind: 'updated',
    patch: { url: 'https://example.com/page' },
  });
  assert.equal(updated.state, 'open');
  assert.equal(updated.url, 'https://example.com/page');
});

test('registry returns to the live opener after a popup closes', () => {
  const registry = new ManagedTargetRegistry();
  const opener = registry.open({ tabId: 10, ownership: 'agent' });
  registry.applyEvent(opener.targetId, { kind: 'updated', patch: {} });

  const popup = registry.open({
    tabId: 11,
    ownership: 'agent',
    role: 'popup',
    openerTargetId: opener.targetId,
  });
  registry.applyEvent(popup.targetId, { kind: 'updated', patch: {} });

  // active is now the popup
  assert.equal(registry.active()?.tabId, 11);

  registry.applyEvent(popup.targetId, { kind: 'closed', now: 0 });
  const fallback = registry.fallbackAfterClose();
  assert.equal(fallback?.tabId, 10);
  assert.equal(registry.active()?.tabId, 10);
});

test('closing the active target clears it and falls back to another open target', () => {
  const registry = new ManagedTargetRegistry();
  const primary = registry.open({ tabId: 10, ownership: 'agent' });
  registry.applyEvent(primary.targetId, { kind: 'updated', patch: {} });
  const second = registry.open({ tabId: 12, ownership: 'agent' });
  registry.applyEvent(second.targetId, { kind: 'updated', patch: {} });

  assert.equal(registry.active()?.tabId, 12);
  registry.applyEvent(second.targetId, { kind: 'closed', now: 0 });
  assert.equal(registry.active(), null);
  const fallback = registry.fallbackAfterClose();
  assert.equal(fallback?.tabId, 10);
});

test('a closed target cannot be resurrected by late events', () => {
  const registry = new ManagedTargetRegistry();
  const target = registry.open({ tabId: 10, ownership: 'agent' });
  registry.applyEvent(target.targetId, { kind: 'closed', now: 0 });

  assert.throws(
    () => registry.applyEvent(target.targetId, { kind: 'updated', patch: { url: 'x' } }),
    /closed; late events are rejected/,
  );
});

test('applying an event to an unknown target throws', () => {
  const registry = new ManagedTargetRegistry();
  assert.throws(
    () => registry.applyEvent('nope', { kind: 'activated' }),
    /does not exist/,
  );
});

test('closing is reversible until the target is actually closed', () => {
  const registry = new ManagedTargetRegistry();
  const target = registry.open({ tabId: 10, ownership: 'agent' });
  const closing = registry.applyEvent(target.targetId, { kind: 'closing', now: 0 });
  assert.equal(closing.state, 'closing');

  const back = registry.applyEvent(target.targetId, {
    kind: 'updated',
    patch: { url: 'https://recovered/' },
  });
  assert.equal(back.state, 'open');
});
