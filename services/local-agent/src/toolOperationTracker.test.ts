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

test('terminal events inherit target/details from the start event when the tool only summarizes input', () => {
  // view_file_chunk-style: only summarizeInput sets target; on_tool_end has nothing.
  const tracker = new ToolOperationTracker('req-1', createOperationRegistry({
    view_file_chunk: {
      title: '看片段',
      source: { provider: 'toolkit', name: 'bash', toolName: 'view_file_chunk' },
      summarizeInput: (input) => {
        const path = (input as { path?: string } | undefined)?.path;
        return path ? { target: path, details: { startLine: 1, endLine: 50 } } : null;
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
  assert.deepEqual(completed.operation.details, { startLine: 1, endLine: 50 });
});

test('terminal events keep their own summary fields over inherited ones', () => {
  const tracker = new ToolOperationTracker('req-1', createOperationRegistry({
    browser_open: {
      title: '打开网页',
      source: { provider: 'toolkit', name: 'browser', toolName: 'browser_open' },
      summarizeInput: (input) => {
        const url = (input as { url?: string } | undefined)?.url;
        return url ? { target: url, summary: '打开网页' } : null;
      },
      summarizeOutput: () => ({ summary: '页面：Example' }),
    },
  }));

  tracker.accept({
    event: 'on_tool_start',
    name: 'browser_open',
    toolCallId: 'call-1',
    input: { url: 'https://example.com' },
  });
  const completed = tracker.accept({
    event: 'on_tool_end',
    name: 'browser_open',
    toolCallId: 'call-1',
    output: '{}',
  });

  // target inherited from start, summary kept from the terminal payload.
  assert.equal(completed.operation.target, 'https://example.com');
  assert.equal(completed.operation.summary, '页面：Example');
});
