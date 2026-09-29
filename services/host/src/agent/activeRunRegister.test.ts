import assert from 'node:assert/strict';
import test from 'node:test';

import { ActiveRunRegister } from './activeRunRegister.js';

test('ActiveRunRegister reports the run in flight', () => {
  const runs = new ActiveRunRegister();
  assert.equal(runs.read(), null);

  const run = runs.begin('req-1');
  assert.equal(run.requestId, 'req-1');
  assert.equal(run.state, 'running');
  assert.equal(run.activity, 'thinking');
  assert.equal(runs.read(), run);

  runs.finish(run);
  assert.equal(runs.read(), null);
});

test('ActiveRunRegister refuses a second run while one holds it', () => {
  const runs = new ActiveRunRegister();
  const run = runs.begin('req-1');

  assert.throws(() => runs.begin('req-2'), /already has an active run "req-1"/);

  runs.finish(run);
  assert.equal(runs.begin('req-2').requestId, 'req-2');
});

test('ActiveRunRegister ignores a stale release', () => {
  const runs = new ActiveRunRegister();
  const first = runs.begin('req-1');
  runs.finish(first);

  const second = runs.begin('req-2');
  // The first run settling late must not retire the run that replaced it.
  runs.finish(first);
  assert.equal(runs.read(), second);
});

test('ActiveRunRegister clears for a Host tearing down', () => {
  const runs = new ActiveRunRegister();
  runs.begin('req-1');
  runs.clear();
  assert.equal(runs.read(), null);
});
