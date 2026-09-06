import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentOperationEvent,
} from '@pinpawo/agent-session';
import {
  configureInflightOperationRegistry,
  createInflightOperationRun,
} from './inflightOperationRun';
import {
  emitLocalServerToolOperationEvent,
  isHumanReviewInterruptError,
} from './localServerOperationEvents';
import { createOperationRegistryFromToolkits } from './events/operationRegistry';
import { createBashToolkit } from './toolkits/local';
import { createGitToolkit } from './toolkits/git';

const localToolOperationRegistry = createOperationRegistryFromToolkits([
  createBashToolkit(),
  createGitToolkit(),
]);

test('emitLocalServerToolOperationEvent emits one operation for a normal tool event', () => {
  const run = createInflightOperationRun('req-1');
  configureInflightOperationRegistry(run, localToolOperationRegistry);
  const emitted: AgentOperationEvent[] = [];

  const event = emitLocalServerToolOperationEvent({
    run,
    payload: {
      event: 'on_tool_start',
      name: 'read_file',
      input: { path: 'README.md' },
    },
    emit: (item) => emitted.push(item),
    log: () => undefined,
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], event);
  assert.equal(emitted[0]?.phase, 'started');
  assert.equal(emitted[0]?.operation.kind, 'bash.read_file');
});

test('emitLocalServerToolOperationEvent maps human review tool errors to interrupted operations', () => {
  const run = createInflightOperationRun('req-1');
  const emitted: AgentOperationEvent[] = [];

  emitLocalServerToolOperationEvent({
    run,
    payload: {
      event: 'on_tool_start',
      name: 'run_shell',
      input: { command: 'git status' },
    },
    emit: (item) => emitted.push(item),
    log: () => undefined,
  });
  const interrupted = emitLocalServerToolOperationEvent({
    run,
    payload: {
      event: 'on_tool_error',
      name: 'run_shell',
      error: {
        interrupts: [{
          value: {
            kind: 'review',
            review: {
              id: 'review-1',
              schemaVersion: 1,
              view: { kind: 'plain', body: 'Approve?' },
              options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
            },
          },
        }],
      },
    },
    emit: (item) => emitted.push(item),
    log: () => undefined,
  });

  assert.equal(emitted.length, 2);
  assert.equal(interrupted.phase, 'interrupted');
  assert.equal(emitted[1]?.phase, 'interrupted');
  assert.equal(emitted[1]?.operation.id, emitted[0]?.operation.id);
  assert.equal(emitted[1]?.raw?.input, undefined);
});

test('isHumanReviewInterruptError accepts LangGraph interrupt shapes', () => {
  assert.equal(isHumanReviewInterruptError({
    __interrupt__: [{
      value: {
        kind: 'review',
        review: {
          id: 'review-1',
          schemaVersion: 1,
          view: { kind: 'plain', body: 'Approve?' },
          options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
        },
        pendingAction: {
          actionId: 'call-1',
          toolName: 'run_shell',
          args: { command: 'git status' },
        },
      },
    }],
  }), true);
  assert.equal(isHumanReviewInterruptError({
    __interrupt__: [{
      value: {
        kind: 'review',
      },
    }],
  }), false);
  assert.equal(isHumanReviewInterruptError(new Error('plain failure')), false);
});
