import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STUDIO_ERROR_CODES,
  buildStudioThreadId,
  isStudioErrorCode,
  parseStudioCancelScope,
  parseStudioInvocationIdentity,
  type StudioInvocationIdentity,
  type StudioWikiChangedEvent,
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

describe('parseStudioCancelScope', () => {
  it('parses each cancel scope distinctly', () => {
    assert.deepEqual(
      parseStudioCancelScope({ scope: 'run', runId: 'run-1' }),
      { scope: 'run', runId: 'run-1' },
    );
    assert.deepEqual(
      parseStudioCancelScope({ scope: 'task', runId: 'run-1', taskId: 'task-a' }),
      { scope: 'task', runId: 'run-1', taskId: 'task-a' },
    );
    assert.deepEqual(
      parseStudioCancelScope({ scope: 'invocation', runId: 'run-1', invocationId: 'inv-1' }),
      { scope: 'invocation', runId: 'run-1', invocationId: 'inv-1' },
    );
  });

  it('rejects a scope-less cancel instead of defaulting to run scope', () => {
    // Guessing a scope here would stop sibling invocations that were never
    // meant to be cancelled.
    assert.equal(parseStudioCancelScope({ runId: 'run-1' }), null);
  });

  it('rejects a task cancel that omits taskId', () => {
    assert.equal(parseStudioCancelScope({ scope: 'task', runId: 'run-1' }), null);
  });

  it('rejects an invocation cancel that omits invocationId', () => {
    assert.equal(parseStudioCancelScope({ scope: 'invocation', runId: 'run-1' }), null);
  });

  it('rejects malformed input', () => {
    assert.equal(parseStudioCancelScope(null), null);
    assert.equal(parseStudioCancelScope([]), null);
    assert.equal(parseStudioCancelScope({ scope: 'run' }), null);
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
    assert.notEqual(
      buildStudioThreadId(identity),
      buildStudioThreadId({ ...identity, invocationId: 'inv-2' }),
    );
  });

  it('separates the same pet across different tasks, runs and conversations', () => {
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

describe('wiki change event', () => {
  it('carries changed paths only, leaving content to be read from the wiki', () => {
    // SSE exposes Studio's output, not its execution detail: no task, pet or
    // tool information crosses this boundary.
    const event: StudioWikiChangedEvent = {
      type: 'wiki_changed',
      runId: 'run-1',
      conversationId: 'conv-1',
      changedPaths: ['index.md', 'topics/auth.md'],
      occurredAt: '2026-08-09T00:00:00.000Z',
    };

    assert.deepEqual(Object.keys(event).sort(), [
      'changedPaths', 'conversationId', 'occurredAt', 'runId', 'type',
    ]);
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
