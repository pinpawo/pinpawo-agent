import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentOperationEvent } from '@pinpawo/agent-session';
import {
  configureInflightOperationRegistry,
  createInflightOperationRun,
  emitInflightToolEvent,
  finishInflightOperations,
} from './inflightOperationRun';
import { createOperationRegistryFromToolkits } from './events/operationRegistry';
import { createBashToolkit, createGitToolkit } from './toolkits/local';

const localToolOperationRegistry = createOperationRegistryFromToolkits([
  createBashToolkit(),
  createGitToolkit(),
]);

test('inflight operation run emits tool stream events as operations', () => {
  const run = createInflightOperationRun('req-1');
  configureInflightOperationRegistry(run, localToolOperationRegistry);
  const emitted: AgentOperationEvent[] = [];

  const event = emitInflightToolEvent(run, {
    event: 'on_tool_start',
    name: 'read_file',
    input: { path: 'README.md' },
  }, (item) => emitted.push(item));

  assert.equal(event.type, 'operation');
  assert.equal(event.requestId, 'req-1');
  assert.equal(event.phase, 'started');
  assert.equal(event.operation.id, 'tool-1');
  assert.equal(event.operation.kind, 'bash.read_file');
  assert.deepEqual(emitted, [event]);
});

test('inflight operation run closes active operations with terminal phase', () => {
  const run = createInflightOperationRun('req-1');
  const emitted: AgentOperationEvent[] = [];

  emitInflightToolEvent(run, {
    event: 'on_tool_start',
    name: 'run_shell',
    input: { command: 'npm test' },
  }, (item) => emitted.push(item));
  finishInflightOperations(run, 'interrupted', (item) => emitted.push(item));
  finishInflightOperations(run, 'interrupted', (item) => emitted.push(item));

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]?.phase, 'started');
  assert.equal(emitted[1]?.phase, 'interrupted');
  assert.equal(emitted[1]?.operation.id, 'tool-1');
});
