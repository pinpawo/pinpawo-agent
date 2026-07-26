import assert from 'node:assert/strict';
import test from 'node:test';
import { emitInflightToolEvent } from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import type { LocalAgentControlServerMessage } from './localAgentProtocol';
import type { AgentOperationEvent } from '@pinpawo/agent-session';

function createTestController() {
  const controls: LocalAgentControlServerMessage[] = [];
  const operations: AgentOperationEvent[] = [];
  const controller = new InflightRequestController<string>({
    emitOperation: (_key, event) => {
      operations.push(event);
    },
    sendControl: (_key, message) => {
      controls.push(message);
    },
  });
  return { controller, controls, operations };
}

test('InflightRequestController tracks concurrent requests for the same transport', () => {
  const { controller, controls, operations } = createTestController();
  const observedOperations: AgentOperationEvent[] = [];
  const first = controller.start('client', 'req-1', {
    observeOperation: (event) => observedOperations.push(event),
  });
  emitInflightToolEvent(first, {
    event: 'on_tool_start',
    name: 'read_file',
    input: { path: 'README.md' },
  }, (event) => operations.push(event));

  const second = controller.start('client', 'req-2');

  assert.equal(first.controller.signal.aborted, false);
  assert.equal(controller.get('client'), second);
  assert.deepEqual(controls, []);
  assert.deepEqual(operations.map((event) => event.phase), ['started']);
  assert.equal(observedOperations.length, 0);

  controller.sendInterrupted('client', first);
  assert.deepEqual(controls, [{
    type: 'interrupted',
    requestId: 'req-1',
    message: 'interrupted',
  }]);
  assert.deepEqual(operations.map((event) => event.phase), ['started', 'interrupted']);
  assert.deepEqual(observedOperations.map((event) => event.phase), ['interrupted']);
  controller.clear('client', first);
  assert.equal(controller.get('client'), second);
});

test('InflightRequestController does not report terminal interruption before the owner settles', () => {
  const { controller, controls } = createTestController();
  const run = controller.start('client', 'req-1');

  const interrupted = controller.interrupt('client', { requestId: 'req-1' });

  assert.equal(interrupted, run);
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(controller.get('client'), run);
  assert.deepEqual(controls, [{
    type: 'interrupting',
    requestId: 'req-1',
    message: 'interrupting',
  }]);

  controller.sendInterrupted('client', run);
  controller.clear('client', run);
  assert.equal(controller.get('client'), null);
  assert.equal(controls.at(-1)?.type, 'interrupted');
});

test('InflightRequestController abortAll signals every request without clearing ownership', () => {
  const { controller, controls, operations } = createTestController();
  const first = controller.start('client', 'req-1');
  const second = controller.start('client', 'req-2');

  controller.abortAll('client');

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, true);
  assert.equal(controller.get('client'), second);
  assert.deepEqual(controls, []);
  assert.deepEqual(operations, []);
});

test('InflightRequestController routes interrupts by requestId', () => {
  const { controller } = createTestController();
  const first = controller.start('client', 'req-1');
  const second = controller.start('client', 'req-2');

  assert.equal(controller.interrupt('client', { requestId: 'req-1' }), first);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
});

test('InflightRequestController reports active requests across keys', () => {
  const { controller } = createTestController();
  assert.equal(controller.hasActiveRequest(), false);

  const run = controller.start('peer-1', 'req-1');
  assert.equal(controller.hasActiveRequest(), true);
  assert.equal(controller.get('peer-2'), null);

  controller.clear('peer-1', run);
  assert.equal(controller.hasActiveRequest(), false);
});
