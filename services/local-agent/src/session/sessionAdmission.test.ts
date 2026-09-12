import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionAdmission } from './sessionAdmission';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('a transition is refused while a run holds the session', async () => {
  const admission = new SessionAdmission();
  const started = deferred();
  const running = deferred();
  let refused = false;

  const run = admission.runInSession(async () => {
    started.resolve();
    await running.promise;
  });
  // The hold is taken when the run starts, not when it is queued, so the
  // transition is only refused once the run is actually executing.
  await started.promise;

  const transition = admission.transact(
    async () => 'committed',
    () => {
      refused = true;
      return 'refused';
    },
  );

  assert.equal(await transition, 'refused');
  assert.ok(refused);
  running.resolve();
  await run;
});

test('a run waits for an in-flight transition to settle', async () => {
  const admission = new SessionAdmission();
  const transitioning = deferred();
  const order: string[] = [];

  const transition = admission.transact(async () => {
    await transitioning.promise;
    order.push('transition');
  }, () => {
    throw new Error('should not be refused');
  });
  const run = admission.runInSession(async () => {
    order.push('run');
  });

  transitioning.resolve();
  await Promise.all([transition, run]);
  assert.deepEqual(order, ['transition', 'run']);
});

test('transitions do not overlap each other', async () => {
  const admission = new SessionAdmission();
  const first = deferred();
  const order: string[] = [];

  const a = admission.transact(async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
  }, () => { throw new Error('unexpected'); });
  const b = admission.transact(async () => {
    order.push('b');
  }, () => { throw new Error('unexpected'); });

  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
});

test('a failed transition still releases the session', async () => {
  const admission = new SessionAdmission();

  await assert.rejects(
    admission.transact(async () => {
      throw new Error('boom');
    }, () => { throw new Error('unexpected'); }),
    /boom/,
  );

  // A transition that threw must not leave the session held: the next one
  // has to be admitted rather than waiting on a promise nothing resolves.
  assert.equal(
    await admission.transact(async () => 'next', () => 'refused'),
    'next',
  );
});

test('a failed run releases its hold on the session', async () => {
  const admission = new SessionAdmission();

  await assert.rejects(
    admission.runInSession(async () => {
      throw new Error('run failed');
    }),
    /run failed/,
  );

  assert.equal(admission.hasActiveRun(), false);
  assert.equal(
    await admission.transact(async () => 'committed', () => 'refused'),
    'committed',
  );
});

// Not covered here: a transition queued *behind another* meeting a run that
// began in between. A run waits for the whole transition chain before taking
// its hold, so the queued transition always reaches the front first — the
// interleaving simply does not arise. "Refused while a run is executing" is
// covered by the first test above.
