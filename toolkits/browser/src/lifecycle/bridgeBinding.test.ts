/**
 * Production-seam tests for `bindBridgeToController`.
 *
 * The regression this guards is the one the #583 review called out: the
 * authoritative generation-bump path (`notifyGenerationAdvance`) previously had
 * *no production caller*, so on reconnect (`connectionGeneration` bump) or a
 * managed-target close (`targetGeneration` bump) an in-flight navigation would
 * hang silently until its deadline. `onGenerationChanged` + this binding makes
 * those bumps reach the controller deterministically.
 *
 * The tests use a mock `RuntimeEventSource` (the narrow bridge surface the
 * binding consumes) so the failure paths are driven deterministically; the
 * real-bridge wiring of `onGenerationChanged` at the two bump points is covered
 * in `bridge.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycleController } from './controller';
import {
  bindBridgeToController,
  type RuntimeEventSource,
  type GenerationChange,
} from './bridgeBinding';
import type { BrowserRuntimeEvent } from './events';

/** A scripted event source that records installed listeners so the binding's
 * forwarding can be driven and torn down. */
class MockSource implements RuntimeEventSource {
  eventListeners: Array<(event: BrowserRuntimeEvent) => void> = [];
  generationListeners: Array<(change: GenerationChange) => void> = [];

  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  onGenerationChanged(listener: (change: GenerationChange) => void): () => void {
    this.generationListeners.push(listener);
    return () => {
      this.generationListeners = this.generationListeners.filter((l) => l !== listener);
    };
  }

  emitEvent(event: BrowserRuntimeEvent) {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  emitGeneration(change: GenerationChange) {
    for (const listener of [...this.generationListeners]) listener(change);
  }
}

function startBoundNavigation(controller: BrowserLifecycleController, gen: number): void {
  controller.beginNavigation(
    'https://example.com/',
    'https://example.com',
    1,
    1,
    gen,
  );
}

test('binding forwards runtime events to the controller', () => {
  const source = new MockSource();
  const controller = new BrowserLifecycleController();
  const unsubscribe = bindBridgeToController(source, controller);

  startBoundNavigation(controller, 1);
  source.emitEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: 0,
    type: 'navigation.committed',
    url: 'https://example.com/',
  });
  assert.equal(controller.getSnapshot().navigation?.phase, 'committed');
  unsubscribe();
});

test('binding fails the navigation deterministically when the connection generation bumps (reconnect)', () => {
  const source = new MockSource();
  const controller = new BrowserLifecycleController();
  const unsubscribe = bindBridgeToController(source, controller);

  startBoundNavigation(controller, 1);
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');

  // The bridge reconnected: connectionGeneration went 1 -> 2.
  source.emitGeneration({ connectionGeneration: 2, targetGeneration: 1 });

  const failed = controller.getSnapshot().navigation;
  assert.equal(failed?.phase, 'failed');
  assert.equal(failed?.error?.code, 'runtime_disconnected');
  // A dropped connection is recoverable by rebinding -> retryable.
  assert.equal(failed?.error?.retryable, true);
  unsubscribe();
});

test('binding fails the navigation deterministically when the target generation bumps (target closed)', () => {
  const source = new MockSource();
  const controller = new BrowserLifecycleController();
  const unsubscribe = bindBridgeToController(source, controller);

  startBoundNavigation(controller, 1);
  assert.equal(controller.getSnapshot().navigation?.phase, 'requested');

  // The managed target closed: targetGeneration went 1 -> 2.
  source.emitGeneration({ connectionGeneration: 1, targetGeneration: 2 });

  const failed = controller.getSnapshot().navigation;
  assert.equal(failed?.phase, 'failed');
  assert.equal(failed?.error?.code, 'target_closed');
  // The tab is gone; retrying the same target cannot succeed -> not retryable.
  assert.equal(failed?.error?.retryable, false);
  unsubscribe();
});

test('unsubscribe tears down both event and generation bindings', () => {
  const source = new MockSource();
  const controller = new BrowserLifecycleController();
  const unsubscribe = bindBridgeToController(source, controller);
  startBoundNavigation(controller, 1);
  unsubscribe();

  // After unsubscribe, neither events nor generation bumps reach the controller.
  source.emitEvent({
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: 1,
    tabId: 1,
    timestamp: 0,
    type: 'navigation.committed',
    url: 'https://example.com/',
  });
  source.emitGeneration({ connectionGeneration: 2, targetGeneration: 1 });

  const snapshot = controller.getSnapshot();
  // No listeners installed, so nothing was forwarded: still `requested`.
  assert.equal(snapshot.navigation?.phase, 'requested');
  assert.equal(snapshot.navigation?.error, undefined);
});
