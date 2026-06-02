import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentToolEventTracker } from './toolEventTracker';

test('SubagentToolEventTracker assigns stable synthetic toolCallId values', () => {
  const tracker = new SubagentToolEventTracker();
  const started = tracker.accept({
    event: 'on_tool_start',
    name: 'read_file',
    input: { path: 'README.md' },
  });
  const updated = tracker.accept({
    event: 'on_tool_event',
    name: 'read_file',
    data: { progress: 'reading' },
  });
  const completed = tracker.accept({
    event: 'on_tool_end',
    name: 'read_file',
    output: 'done',
  });

  assert.equal(started.toolCallId, 'subagent-tool-1');
  assert.equal(updated.toolCallId, 'subagent-tool-1');
  assert.equal(completed.toolCallId, 'subagent-tool-1');
  assert.deepEqual(tracker.finishActive('failed'), []);
});

test('SubagentToolEventTracker preserves explicit toolCallId values', () => {
  const tracker = new SubagentToolEventTracker();
  const started = tracker.accept({
    event: 'on_tool_start',
    name: 'run_shell',
    toolCallId: 'call-1',
    input: { command: 'npm test' },
  });
  const failed = tracker.accept({
    event: 'on_tool_error',
    name: 'run_shell',
    toolCallId: 'call-1',
    error: 'failed',
  });

  assert.equal(started.toolCallId, 'call-1');
  assert.equal(failed.toolCallId, 'call-1');
  assert.deepEqual(tracker.finishActive('failed'), []);
});

test('SubagentToolEventTracker closes dangling tools on natural completion', () => {
  const tracker = new SubagentToolEventTracker();
  tracker.accept({
    event: 'on_tool_start',
    name: 'browser_open',
    input: { url: 'https://example.com' },
  });

  assert.deepEqual(tracker.finishActive('completed'), [
    {
      event: 'on_tool_end',
      toolCallId: 'subagent-tool-1',
      name: 'browser_open',
      output: undefined,
    },
  ]);
  assert.deepEqual(tracker.finishActive('failed'), []);
});

test('SubagentToolEventTracker keeps operation metadata on dangling terminal events', () => {
  const tracker = new SubagentToolEventTracker();
  tracker.accept({
    event: 'on_tool_start',
    name: 'custom_tool',
    input: {},
    operation: {
      kind: 'capability.custom',
      title: 'Custom Tool',
      source: {
        provider: 'capability',
        name: 'custom_tool',
      },
    },
  });

  const completed = tracker.finishActive('completed');

  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0]?.operation, {
    kind: 'capability.custom',
    title: 'Custom Tool',
    source: {
      provider: 'capability',
      name: 'custom_tool',
    },
  });
});

test('SubagentToolEventTracker closes dangling tools on failure', () => {
  const tracker = new SubagentToolEventTracker();
  tracker.accept({
    event: 'on_tool_start',
    name: 'browser_open',
    input: { url: 'https://example.com' },
  });
  const error = new Error('interrupted');

  assert.deepEqual(tracker.finishActive('failed', error), [
    {
      event: 'on_tool_error',
      toolCallId: 'subagent-tool-1',
      name: 'browser_open',
      error,
    },
  ]);
  assert.deepEqual(tracker.finishActive('failed'), []);
});

test('SubagentToolEventTracker can recover from update-before-start events', () => {
  const tracker = new SubagentToolEventTracker();
  const updated = tracker.accept({
    event: 'on_tool_event',
    name: 'read_file',
    data: { progress: 'reading' },
  });
  const completed = tracker.accept({
    event: 'on_tool_end',
    name: 'read_file',
    output: 'done',
  });

  assert.equal(updated.toolCallId, 'subagent-tool-1');
  assert.equal(completed.toolCallId, 'subagent-tool-1');
  assert.deepEqual(tracker.finishActive('failed'), []);
});
