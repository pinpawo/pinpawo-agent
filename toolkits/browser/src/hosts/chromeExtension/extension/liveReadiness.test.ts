import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentReadyEvent,
  domChangedEvent,
  liveReadinessBurst,
  navigationCommittedEvent,
  networkActivityEvent,
} from './liveReadiness';

test('network activity tracks signed inflight deltas', () => {
  const req = networkActivityEvent({ kind: 'request', timestamp: 0 }, 7, 2);
  assert.equal(req.event, 'network.activity');
  assert.equal(req.payload.inflightRequests, 3);

  const finish = networkActivityEvent({ kind: 'finish', timestamp: 0 }, 7, 3);
  assert.equal(finish.payload.inflightRequests, 2);

  // A fail can drive the count to 0 but never negative.
  const failLow = networkActivityEvent({ kind: 'fail', timestamp: 0 }, 7, 0);
  assert.equal(failLow.payload.inflightRequests, 0);
});

test('document ready maps readyState through', () => {
  const ev = documentReadyEvent({ readyState: 'interactive', timestamp: 0 }, 7, 'https://x.com/');
  assert.equal(ev.event, 'document.ready');
  assert.deepEqual(ev.payload, { readyState: 'interactive' });
  assert.equal(ev.url, 'https://x.com/');
});

test('dom.changed clamps textLength and revision to safe bounds', () => {
  const ev = domChangedEvent(
    { textLength: -3, textRevision: 0, timestamp: 0 },
    7,
    'https://x.com/',
  );
  assert.equal(ev.payload.textLength, 0);
  assert.equal(ev.payload.textRevision, 1);

  const ok = domChangedEvent(
    { textLength: 42, textRevision: 5, timestamp: 0 },
    7,
    'https://x.com/',
  );
  assert.deepEqual(ok.payload, { textLength: 42, textRevision: 5 });
});

test('navigation.committed carries the commit URL', () => {
  const ev = navigationCommittedEvent({ url: 'https://x.com/a', timestamp: 0 }, 7);
  assert.equal(ev.event, 'navigation.committed');
  assert.equal(ev.url, 'https://x.com/a');
});

test('liveReadinessBurst emits commit, ready, network, dom in reducer order', () => {
  const events = liveReadinessBurst({
    tabId: 7,
    url: 'https://x.com/',
    readyState: 'complete',
    inflight: 1,
    textLength: 1200,
    textRevision: 2,
  });
  assert.deepEqual(
    events.map((e) => e.event),
    ['navigation.committed', 'document.ready', 'network.activity', 'dom.changed'],
  );
});

test('liveReadinessBurst requires a valid tab id and url', () => {
  assert.deepEqual(liveReadinessBurst({ tabId: 0, url: 'https://x.com/' }), []);
  assert.deepEqual(liveReadinessBurst({ tabId: 7, url: '' }), []);
});

test('liveReadinessBurst omits optional facts that were not observed', () => {
  const events = liveReadinessBurst({ tabId: 7, url: 'https://x.com/' });
  assert.deepEqual(events.map((e) => e.event), ['navigation.committed']);
});
