import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLifecycleController } from './controller';
import {
  driveInteractionSettle,
  INTERACTION_SETTLE_DEADLINE_MS,
} from './interactionSettle';
import type { BrowserRuntimeEvent } from './events';

/** Time well past the 300ms settling window but far inside a normal deadline. */
const SETTLING_PAST = 400;

/** Start a navigation bound to an external generation (as the production seam does). */
function bindNavigation(controller: BrowserLifecycleController, gen: number): void {
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

/** A committed + ready + text-sampled page at gen `gen`, sufficient to reach readable. */
function settledPageEvents(gen: number): BrowserRuntimeEvent[] {
  return [
    { ...event('navigation.committed', gen, 'https://example.com/'), timestamp: 0 },
    { ...event('document.ready', gen, undefined, { readyState: 'complete' }), timestamp: 10 },
    { ...event('dom.changed', gen, undefined, { textLength: 42, textRevision: 1 }), timestamp: 500 },
  ];
}

test('a newer navigation generation hands off to full readiness', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
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

test('commits within the current generation settle to readable at the last event', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
  const outcome = driveInteractionSettle(controller, settledPageEvents(1), 0, {
    now: () => 500, // past the settle window at the final poll
    deadlineMs: 10_000,
  });
  assert.equal(outcome.status, 'settled');
  assert.equal(outcome.snapshot.navigation?.phase, 'readable');
});

test('a same-timestamp burst is not blocked by the settle-baseline reset (M1)', () => {
  // All three events share timestamp 0. Polling after *every* event would re-run
  // `advanceSettling` and reset the network-settle baseline on each poll, so the
  // final poll's `now` equals the baseline it just wrote; the default
  // poll-once-at-the-last-event cadence must still reach `readable`.
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
  const events = settledPageEvents(1).map((e) => ({ ...e, timestamp: 0 }));
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => SETTLING_PAST,
    deadlineMs: 10_000,
  });
  assert.equal(outcome.status, 'settled');
  assert.equal(outcome.snapshot.navigation?.phase, 'readable');
});

test('a cross-origin commit fails the settle deterministically', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
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
  bindNavigation(controller, 1);
  const events = [event('navigation.committed', 1, 'https://example.com/')];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => 100, // well inside the deadline
    deadlineMs: INTERACTION_SETTLE_DEADLINE_MS,
  });
  assert.equal(outcome.status, 'pending');
});

test('an injected clock past the deadline yields timed_out', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
  const events = [event('navigation.committed', 1, 'https://example.com/')];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => INTERACTION_SETTLE_DEADLINE_MS + 1,
    deadlineMs: INTERACTION_SETTLE_DEADLINE_MS,
  });
  assert.equal(outcome.status, 'timed_out');
});

test('a document.ready without body text keeps settling (not falsely readable)', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
  const events = [
    { ...event('navigation.committed', 1, 'https://example.com/'), timestamp: 0 },
    { ...event('document.ready', 1, undefined, { readyState: 'complete' }), timestamp: 10 },
  ];
  const outcome = driveInteractionSettle(controller, events, 0, {
    now: () => 500, // no text sample yet → the page shell is not readable
    deadlineMs: 10_000,
  });
  assert.equal(outcome.status, 'pending');
  assert.notEqual(outcome.snapshot.navigation?.phase, 'readable');
});

test('a custom shouldPoll can sample mid-batch', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 1);
  const outcomes = driveInteractionSettle(
    controller,
    settledPageEvents(1),
    0,
    {
      now: () => 500,
      deadlineMs: 10_000,
      shouldPoll: () => true, // poll after every event (caller's explicit choice)
    },
  );
  // Even with per-event polling the page reaches readable once the ready + text
  // events have been folded in and the settle window has passed.
  assert.equal(outcomes.status, 'settled');
});

test('a navigation-scoped event with no navigationGeneration folds into the current gen', () => {
  const controller = new BrowserLifecycleController();
  bindNavigation(controller, 2);
  const noGen = event('dom.changed', 2, undefined, { textLength: 10, textRevision: 2 });
  const committed: BrowserRuntimeEvent = {
    connectionGeneration: 1,
    targetGeneration: 1,
    tabId: 1,
    timestamp: 0,
    type: 'navigation.committed',
    url: 'https://example.com/',
    navigationGeneration: 2,
  };
  const outcome = driveInteractionSettle(controller, [committed, noGen], 0, {
    now: () => 500,
    deadlineMs: 10_000,
  });
  // Without document.ready the page never becomes readable; it is pending, and
  // crucially not misclassified as a brand-new generation hand-off.
  assert.equal(outcome.status, 'pending');
});
