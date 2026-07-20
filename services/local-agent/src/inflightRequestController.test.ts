import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { emitInflightToolEvent } from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import type { LocalAgentControlServerMessage } from './localAgentProtocol';
import type { LocalAgentOperationEvent } from './events/localAgentRuntimeEvent';

function createTestController(options: { forceInterruptMs?: number } = {}) {
  const controls: LocalAgentControlServerMessage[] = [];
  const operations: LocalAgentOperationEvent[] = [];
  const logs: string[] = [];
  const controller = new InflightRequestController<string>({
    forceInterruptMs: options.forceInterruptMs ?? 10,
    emitOperation: (_key, event) => {
      operations.push(event);
    },
    sendControl: (_key, message) => {
      controls.push(message);
    },
    log: (message) => {
      logs.push(message);
    },
    logPrefix: 'test-agent',
  });
  return { controller, controls, operations, logs };
}

test('InflightRequestController replaces previous request without notifying when requested', () => {
  const { controller, controls, operations } = createTestController();
  const observedOperations: LocalAgentOperationEvent[] = [];
  const first = controller.start('client', 'req-1', {
    observeOperation: (event) => observedOperations.push(event),
  });
  emitInflightToolEvent(first, {
    event: 'on_tool_start',
    name: 'read_file',
    input: { path: 'README.md' },
  }, (event) => operations.push(event));

  const second = controller.start('client', 'req-2', {
    interruptPrevious: true,
    notifyPrevious: false,
  });

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(controller.get('client'), second);
  assert.deepEqual(controls, []);
  assert.deepEqual(operations.map((event) => event.phase), ['started', 'interrupted']);
  assert.deepEqual(observedOperations.map((event) => event.phase), ['interrupted']);
});

test('InflightRequestController replaces previous request with interrupted control message', () => {
  const { controller, controls, operations } = createTestController();
  const first = controller.start('client', 'req-1');
  emitInflightToolEvent(first, {
    event: 'on_tool_start',
    name: 'run_shell',
    input: { command: 'npm test' },
  }, (event) => operations.push(event));

  controller.start('client', 'req-2', {
    interruptPrevious: true,
    notifyPrevious: true,
  });

  assert.deepEqual(controls, [{
    type: 'interrupted',
    requestId: 'req-1',
    message: 'interrupted',
  }]);
  assert.deepEqual(operations.map((event) => event.phase), ['started', 'interrupted']);
});

test('InflightRequestController forces interrupted cleanup after interrupt timeout', async () => {
  const { controller, controls, logs } = createTestController({ forceInterruptMs: 1 });
  const run = controller.start('client', 'req-1');

  const interrupted = controller.interrupt('client', { requestId: 'req-1' });
  await sleep(5);

  assert.equal(interrupted, run);
  assert.equal(run.controller.signal.aborted, true);
  assert.equal(controller.get('client'), null);
  assert.deepEqual(controls, [
    { type: 'interrupting', requestId: 'req-1', message: 'interrupting' },
    { type: 'interrupted', requestId: 'req-1', message: 'interrupted' },
  ]);
  assert.deepEqual(logs, ['[test-agent] force interrupted requestId=req-1']);
});

test('InflightRequestController abortAndClear drops active request without terminal notification', () => {
  const { controller, controls, operations } = createTestController();
  const run = controller.start('client', 'req-1');

  controller.abortAndClear('client', run);

  assert.equal(run.controller.signal.aborted, true);
  assert.equal(controller.get('client'), null);
  assert.deepEqual(controls, []);
  assert.deepEqual(operations, []);
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
