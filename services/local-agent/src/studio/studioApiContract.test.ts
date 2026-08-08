import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STUDIO_ERROR_CODES,
  buildStudioThreadId,
  isStudioErrorCode,
  parseStudioCancelCommand,
  parseStudioInvocationIdentity,
  type StudioInvocationIdentity,
  type StudioStatusSnapshot,
} from './studioApiContract';

const identity: StudioInvocationIdentity = {
  studioId: 'demo',
  runId: 'run-1',
  conversationId: 'conv-1',
  taskId: 'task-a',
  taskIndex: 0,
  petId: 'coder',
  invocationId: 'inv-1',
};

describe('parseStudioCancelCommand', () => {
  it('parses each cancel scope distinctly', () => {
    assert.deepEqual(
      parseStudioCancelCommand({
        command: 'studio.cancel', requestId: 'r1', scope: 'run', runId: 'run-1',
      }),
      { command: 'studio.cancel', requestId: 'r1', scope: 'run', runId: 'run-1' },
    );
    assert.deepEqual(
      parseStudioCancelCommand({
        command: 'studio.cancel', requestId: 'r1', scope: 'task', runId: 'run-1', taskId: 'task-a',
      }),
      { command: 'studio.cancel', requestId: 'r1', scope: 'task', runId: 'run-1', taskId: 'task-a' },
    );
    assert.deepEqual(
      parseStudioCancelCommand({
        command: 'studio.cancel', requestId: 'r1', scope: 'invocation', runId: 'run-1', invocationId: 'inv-1',
      }),
      {
        command: 'studio.cancel', requestId: 'r1', scope: 'invocation', runId: 'run-1', invocationId: 'inv-1',
      },
    );
  });

  it('rejects a scope-less cancel instead of defaulting to run scope', () => {
    // Guessing a scope here would stop sibling invocations that were never
    // meant to be cancelled (#561: cancel must distinguish scopes).
    assert.equal(
      parseStudioCancelCommand({ command: 'studio.cancel', requestId: 'r1', runId: 'run-1' }),
      null,
    );
  });

  it('rejects a task cancel that omits taskId', () => {
    assert.equal(
      parseStudioCancelCommand({
        command: 'studio.cancel', requestId: 'r1', scope: 'task', runId: 'run-1',
      }),
      null,
    );
  });

  it('rejects an invocation cancel that omits invocationId', () => {
    assert.equal(
      parseStudioCancelCommand({
        command: 'studio.cancel', requestId: 'r1', scope: 'invocation', runId: 'run-1',
      }),
      null,
    );
  });

  it('rejects foreign commands', () => {
    assert.equal(parseStudioCancelCommand({ command: 'chat_request' }), null);
    assert.equal(parseStudioCancelCommand(null), null);
    assert.equal(parseStudioCancelCommand([]), null);
  });
});

describe('parseStudioInvocationIdentity', () => {
  it('round-trips a complete identity', () => {
    assert.deepEqual(parseStudioInvocationIdentity(identity), identity);
  });

  it('requires every correlation field', () => {
    for (const key of Object.keys(identity) as (keyof StudioInvocationIdentity)[]) {
      const partial = { ...identity };
      delete partial[key];
      assert.equal(
        parseStudioInvocationIdentity(partial),
        null,
        `expected missing "${key}" to be rejected`,
      );
    }
  });

  it('rejects a non-integer taskIndex', () => {
    assert.equal(parseStudioInvocationIdentity({ ...identity, taskIndex: 1.5 }), null);
    assert.equal(parseStudioInvocationIdentity({ ...identity, taskIndex: -1 }), null);
    assert.equal(parseStudioInvocationIdentity({ ...identity, taskIndex: '0' }), null);
  });
});

describe('buildStudioThreadId', () => {
  it('separates concurrent invocations of the same pet in the same run', () => {
    const a = buildStudioThreadId(identity);
    const b = buildStudioThreadId({ ...identity, invocationId: 'inv-2' });
    assert.notEqual(a, b);
  });

  it('separates the same pet across different tasks and runs', () => {
    assert.notEqual(
      buildStudioThreadId(identity),
      buildStudioThreadId({ ...identity, taskId: 'task-b' }),
    );
    assert.notEqual(
      buildStudioThreadId(identity),
      buildStudioThreadId({ ...identity, runId: 'run-2' }),
    );
    assert.notEqual(
      buildStudioThreadId(identity),
      buildStudioThreadId({ ...identity, conversationId: 'conv-2' }),
    );
  });

  it('is stable for the same identity', () => {
    assert.equal(buildStudioThreadId(identity), buildStudioThreadId({ ...identity }));
  });
});

describe('studio status snapshot shape', () => {
  it('models capacity as counts so parallelism is not blocked by a boolean', () => {
    // V1 may run with maxConcurrent 1, but the contract must express "how many"
    // rather than a global busy flag (#561 design principle 4).
    const snapshot: StudioStatusSnapshot = {
      studioId: 'demo',
      plannerPetId: 'lead',
      workerPetIds: ['coder', 'writer'],
      host: { maxConcurrent: 1, inUse: 1 },
      pets: [
        { petId: 'coder', maxConcurrent: 1, inUse: 1 },
        { petId: 'writer', maxConcurrent: 2, inUse: 0 },
      ],
      leases: [{ identity, status: 'running', acquiredAt: '2026-08-09T00:00:00.000Z' }],
    };

    assert.equal(typeof snapshot.host.maxConcurrent, 'number');
    // A busy pet must not imply the whole host is unavailable.
    const writer = snapshot.pets.find((pet) => pet.petId === 'writer');
    assert.ok(writer && writer.inUse < writer.maxConcurrent);
  });

  it('allows multiple simultaneous leases', () => {
    const leases: StudioStatusSnapshot['leases'] = [
      { identity, status: 'waiting_review', acquiredAt: '2026-08-09T00:00:00.000Z' },
      {
        identity: { ...identity, petId: 'writer', invocationId: 'inv-2', taskId: 'task-b', taskIndex: 1 },
        status: 'running',
        acquiredAt: '2026-08-09T00:00:01.000Z',
      },
    ];
    assert.equal(leases.length, 2);
    assert.notEqual(leases[0]!.identity.invocationId, leases[1]!.identity.invocationId);
  });
});

describe('studio error codes', () => {
  it('narrows known codes', () => {
    for (const code of STUDIO_ERROR_CODES) {
      assert.equal(isStudioErrorCode(code), true);
    }
    assert.equal(isStudioErrorCode('nope'), false);
    assert.equal(isStudioErrorCode(undefined), false);
  });
});
