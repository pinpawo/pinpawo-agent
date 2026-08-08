import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycleController } from './controller';
import {
  driveInteractionSettle,
  INTERACTION_SETTLE_DEADLINE_MS,
} from './interactionSettle';
import type { BrowserRuntimeEvent } from './events';

function startNavigation(controller: BrowserLifecycleController, gen: number): void {
  controller.beginNavigation('https://example.com/', 'https://example.com', 1, 1, gen);
}

function event(
  type: BrowserRuntimeEvent['type'],
  gen: number,
  url?: string,
  payload?: Record<string, unknown>,
): BrowserRuntimeEvent {
  return {
    connectionGeneration: 1,
    targetGeneration: 1,
    navigationGeneration: gen,
    tabId: 1,
    timestamp: 0,
    type,
    ...(url !== undefined ? { url } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

test('a newer navigation generation hands off to full readiness', () => {
  const controller = new BrowserLifecycleController();
  startNavigation(controller, 1);
  const events = [
    event('navigation.committed', 1, 'https://example.com/'),
    event('navigation.committed', 2, 'https://example.com/next'),
  ];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => 0,
    deadlineMs: 10_000,
  });
  assert.equal(outcome.status, 'nav_generation');
});

test('commits within the current generation settle to readable after the settle window', () => {
  const controller = new BrowserLifecycleController();
  startNavigation(controller, 1);
  const events = [
    { ...event('navigation.committed', 1, 'https://example.com/'), timestamp: 0 },
    { ...event('document.ready', 1, undefined, { readyState: 'complete' }), timestamp: 10 },
    { ...event('dom.changed', 1, undefined, { textLength: 42, textRevision: 1 }), timestamp: 500 },
  ];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => 500, // the event timeline has advanced past the settle window
    deadlineMs: 10_000,
  });
  assert.equal(outcome.status, 'settled');
  assert.equal(outcome.snapshot.navigation?.phase, 'readable');
});

test('a cross-origin commit fails the settle deterministically', () => {
  const controller = new BrowserLifecycleController();
  startNavigation(controller, 1);
  const events = [event('navigation.committed', 1, 'https://attacker.example/steal')];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => 0,
    deadlineMs: 10_000,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'origin_changed');
});

test('event array ending before a verdict and before the deadline is pending', () => {
  const controller = new BrowserLifecycleController();
  startNavigation(controller, 1);
  const events = [event('navigation.committed', 1, 'https://example.com/')];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => 100, // well inside the deadline
    deadlineMs: INTERACTION_SETTLE_DEADLINE_MS,
  });
  assert.equal(outcome.status, 'pending');
});

test('an injected clock past the deadline yields timed_out', () => {
  const controller = new BrowserLifecycleController();
  startNavigation(controller, 1);
  const events = [event('navigation.committed', 1, 'https://example.com/')];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => INTERACTION_SETTLE_DEADLINE_MS + 1,
    deadlineMs: INTERACTION_SETTLE_DEADLINE_MS,
  });
  assert.equal(outcome.status, 'timed_out');
});
