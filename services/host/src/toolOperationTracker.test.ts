import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationRegistry } from './events/operationRegistry';
import { ToolOperationTracker } from './toolOperationTracker';
import { shellOperationMetadata } from './toolkits/shell/shellTools';

test('run_shell events without repeated input retain the summary without warnings', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const terminal of ['on_tool_end', 'on_tool_error'] as const) {
    const tracker = new ToolOperationTracker('req-1');
    const identity = {
      name: 'run_shell', toolCallId: 'call-1', operation: shellOperationMetadata.run_shell,
    };
    tracker.accept({
      ...identity, event: 'on_tool_start', input: { command: 'pwd', cwd: '/repo' },
    });
    const updated = tracker.accept({ ...identity, event: 'on_tool_event', data: '/repo' });
    const ended = tracker.accept({
      ...identity, event: terminal,
      ...(terminal === 'on_tool_end' ? { output: '/repo' } : { error: 'command failed' }),
    });
    assert.equal(updated.phase, 'updated');
    assert.equal(ended.phase, terminal === 'on_tool_end' ? 'completed' : 'failed');
    for (const event of [updated, ended]) {
      assert.equal(event.operation.summary, 'pwd');
      assert.equal(event.operation.target, '/repo');
    }
  }
  assert.equal(warn.mock.callCount(), 0);
});

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

test('terminal events inherit the start event summary', () => {
  // Only the start event carries the arguments; on_tool_end has nothing to summarize.
  const tracker = new ToolOperationTracker('req-1', createOperationRegistry({
    view_file_chunk: {
      title: '看片段',
      source: { provider: 'toolkit', name: 'bash', toolName: 'view_file_chunk' },
      summarize: (input) => {
        const path = (input as { path?: string } | undefined)?.path;
        return path ? { target: path, blocks: [{ kind: 'text', text: '第 1-50 行' }] } : null;
      },
    },
  }));

  const started = tracker.accept({
    event: 'on_tool_start',
    name: 'view_file_chunk',
    toolCallId: 'call-1',
    input: { path: 'README.md', startLine: 1, endLine: 50 },
  });
  assert.equal(started.operation.target, 'README.md');

  const completed = tracker.accept({
    event: 'on_tool_end',
    name: 'view_file_chunk',
    toolCallId: 'call-1',
    output: '1: # README',
  });

  assert.equal(completed.operation.target, 'README.md');
  assert.deepEqual(completed.operation.blocks, [{ kind: 'text', text: '第 1-50 行' }]);
});


test('the first event with valid input fixes the summary for the call', () => {
  const tracker = new ToolOperationTracker('req-1', createOperationRegistry({
    view_file_chunk: {
      title: '看片段',
      source: { provider: 'toolkit', name: 'bash', toolName: 'view_file_chunk' },
      summarize: (input) => {
        const path = (input as { path?: string } | undefined)?.path;
        return path ? { target: path } : null;
      },
    },
  }));
  const identity = { name: 'view_file_chunk', toolCallId: 'call-1' };

  // A start event without arguments must not pin an empty summary.
  const started = tracker.accept({ ...identity, event: 'on_tool_start' });
  assert.equal(started.operation.target, undefined);

  const updated = tracker.accept({ ...identity, event: 'on_tool_event', input: { path: 'a.md' } });
  assert.equal(updated.operation.target, 'a.md');

  // Later input does not replace the summary already shown for this call.
  const completed = tracker.accept({ ...identity, event: 'on_tool_end', input: { path: 'b.md' }, output: 'ok' });
  assert.equal(completed.operation.target, 'a.md');
});
