import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationRegistry } from './events/operationRegistry';
import { ToolOperationTracker } from './toolOperationTracker';

test('ToolOperationTracker assigns stable synthetic ids when toolCallId is missing', () => {
  const tracker = new ToolOperationTracker('req-1');
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

  assert.equal(started.operation.id, 'tool-1');
  assert.equal(updated.operation.id, 'tool-1');
  assert.equal(completed.operation.id, 'tool-1');
  assert.deepEqual(tracker.finishActive('interrupted'), []);
});

test('ToolOperationTracker preserves explicit toolCallId values', () => {
  const tracker = new ToolOperationTracker('req-1');
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

  assert.equal(started.operation.id, 'call-1');
  assert.equal(failed.operation.id, 'call-1');
  assert.deepEqual(tracker.finishActive('interrupted'), []);
});

test('ToolOperationTracker closes dangling operations with terminal events', () => {
  const tracker = new ToolOperationTracker('req-1');
  tracker.accept({
    event: 'on_tool_start',
    name: 'browser_open',
    input: { url: 'https://example.com' },
  });

  const interrupted = tracker.finishActive('interrupted');

  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.phase, 'interrupted');
  assert.equal(interrupted[0]?.operation.id, 'tool-1');
  assert.deepEqual(interrupted[0]?.raw?.input, { url: 'https://example.com' });
  assert.deepEqual(tracker.finishActive('interrupted'), []);
});

test('ToolOperationTracker does not reuse synthetic ids after terminal events', () => {
  const tracker = new ToolOperationTracker('req-1');
  const first = tracker.accept({
    event: 'on_tool_start',
    name: 'read_file',
    input: { path: 'a.md' },
  });
  tracker.accept({
    event: 'on_tool_end',
    name: 'read_file',
    output: 'done',
  });
  const second = tracker.accept({
    event: 'on_tool_start',
    name: 'read_file',
    input: { path: 'b.md' },
  });

  assert.equal(first.operation.id, 'tool-1');
  assert.equal(second.operation.id, 'tool-2');
});

test('ToolOperationTracker can recover from update-before-start events', () => {
  const tracker = new ToolOperationTracker('req-1');
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

  assert.equal(updated.operation.id, 'tool-1');
  assert.equal(completed.operation.id, 'tool-1');
  assert.deepEqual(tracker.finishActive('interrupted'), []);
});

test('ToolOperationTracker emits structured operation output summaries', () => {
  const tracker = new ToolOperationTracker('req-1', createOperationRegistry({
    run_shell: {
      title: '执行命令',
      source: {
        provider: 'toolkit',
        name: 'bash',
        toolName: 'run_shell',
      },
      summarizeInput: () => ({
        target: 'npm test',
        details: { cwd: '/repo' },
      }),
      summarizeOutput: () => ({
        summary: 'exit 0',
        output: {
          logs: ['stdout: ok'],
          warnings: ['slow test'],
          metrics: { outputBytes: 9 },
        },
      }),
    },
  }));

  tracker.accept({
    event: 'on_tool_start',
    name: 'run_shell',
    toolCallId: 'call-1',
    input: { command: 'npm test' },
  });
  const completed = tracker.accept({
    event: 'on_tool_end',
    name: 'run_shell',
    toolCallId: 'call-1',
    output: 'ok',
  });

  assert.deepEqual(completed.operation.output, {
    status: 'completed',
    target: 'npm test',
    summary: 'exit 0',
    details: { cwd: '/repo' },
    logs: ['stdout: ok'],
    warnings: ['slow test'],
    metrics: { outputBytes: 9 },
    durationMs: completed.operation.output?.durationMs,
  });
  assert.equal(typeof completed.operation.output?.durationMs, 'number');
});
