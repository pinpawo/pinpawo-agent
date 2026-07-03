import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationRegistry } from './operationRegistry';
import { createRootToolEventProjector } from './rootToolEventProjection';
import type { RootStreamChatEvent } from './rootStreamEventAdapter';

function toolEvent(
  data: Record<string, unknown>,
  namespace: string[] = ['general:t1', 'tools:t2'],
): Extract<RootStreamChatEvent, { type: 'tool' }> {
  return { type: 'tool', namespace, data };
}

const registry = createOperationRegistry({
  read_file: {
    title: '读取文件',
    summarizeInput: (input) => {
      const path = (input as { path?: unknown })?.path;
      return typeof path === 'string' ? { target: path } : null;
    },
    source: { provider: 'toolkit', name: 'file', toolName: 'read_file' },
  },
  run_shell: {
    title: '执行命令',
    source: { provider: 'toolkit', name: 'shell', toolName: 'run_shell' },
  },
});

test('projects started/finished tool events joined with registry metadata', () => {
  const project = createRootToolEventProjector({ requestId: 'req-1', registry });

  const started = project(toolEvent({
    event: 'tool-started',
    tool_call_id: 'call-1',
    tool_name: 'read_file',
    input: { path: 'README.md' },
  }));
  assert.ok(started);
  assert.equal(started.operation.phase, 'started');
  assert.equal(started.operation.operation.title, '读取文件');
  assert.equal(started.operation.operation.target, 'README.md');
  assert.equal(started.operation.operation.kind, 'file.read_file');
  assert.equal(started.operation.operation.source?.callId, 'call-1');
  assert.deepEqual(started.namespace, ['general:t1', 'tools:t2']);

  // tool-finished carries no tool_name — the reader's name memory resolves it,
  // so the registry join still lands.
  const finished = project(toolEvent({
    event: 'tool-finished',
    tool_call_id: 'call-1',
    output: 'contents',
  }));
  assert.ok(finished);
  assert.equal(finished.operation.phase, 'completed');
  assert.equal(finished.operation.operation.title, '读取文件');
  assert.equal(finished.operation.raw?.output, 'contents');

  // Duplicate finished for the same call id is dropped.
  assert.equal(project(toolEvent({
    event: 'tool-finished',
    tool_call_id: 'call-1',
    output: 'contents',
  })), null);
});

test('swallows a serialized-interrupt tool-error instead of projecting a failed operation', () => {
  const project = createRootToolEventProjector({ requestId: 'req-1', registry });

  project(toolEvent({
    event: 'tool-started',
    tool_call_id: 'call-2',
    tool_name: 'read_file',
    input: { path: 'a.txt' },
  }));

  const interruptError = project(toolEvent({
    event: 'tool-error',
    tool_call_id: 'call-2',
    message: JSON.stringify([{
      value: {
        kind: 'review',
        pendingAction: { actionId: 'call-2' },
      },
    }]),
  }));
  assert.equal(interruptError, null);

  // A real tool failure still projects as failed.
  project(toolEvent({
    event: 'tool-started',
    tool_call_id: 'call-3',
    tool_name: 'read_file',
    input: { path: 'b.txt' },
  }));
  const failed = project(toolEvent({
    event: 'tool-error',
    tool_call_id: 'call-3',
    message: 'boom',
  }));
  assert.ok(failed);
  assert.equal(failed.operation.phase, 'failed');
  assert.equal(failed.operation.raw?.error, 'boom');
});

test('keeps reader state per namespace when scopes reuse the same tool_call_id', () => {
  const project = createRootToolEventProjector({ requestId: 'req-1', registry });
  const mainScope = ['general:t1', 'tools:t2'];
  const subagentScope = ['general:t1', 'subagent:s1', 'tools:t3'];

  const mainStarted = project(toolEvent({
    event: 'tool-started',
    tool_call_id: 'call-dup',
    tool_name: 'read_file',
    input: { path: 'README.md' },
  }, mainScope));
  assert.ok(mainStarted);
  assert.equal(mainStarted.operation.operation.title, '读取文件');

  // Same call id from another scope while the first is still active: must not
  // be dropped as a duplicate, and must not overwrite the first scope's name.
  const subagentStarted = project(toolEvent({
    event: 'tool-started',
    tool_call_id: 'call-dup',
    tool_name: 'run_shell',
    input: { command: 'ls' },
  }, subagentScope));
  assert.ok(subagentStarted);
  assert.equal(subagentStarted.operation.phase, 'started');
  assert.equal(subagentStarted.operation.operation.title, '执行命令');
  assert.deepEqual(subagentStarted.namespace, subagentScope);

  const mainFinished = project(toolEvent({
    event: 'tool-finished',
    tool_call_id: 'call-dup',
    output: 'contents',
  }, mainScope));
  assert.ok(mainFinished);
  assert.equal(mainFinished.operation.phase, 'completed');
  assert.equal(mainFinished.operation.operation.title, '读取文件');

  // The main scope finishing call-dup must not mark the subagent's call
  // finished: its terminal event still projects, with its own name.
  const subagentFinished = project(toolEvent({
    event: 'tool-finished',
    tool_call_id: 'call-dup',
    output: 'ok',
  }, subagentScope));
  assert.ok(subagentFinished);
  assert.equal(subagentFinished.operation.phase, 'completed');
  assert.equal(subagentFinished.operation.operation.title, '执行命令');
});

test('falls back to tool name and runtime source for unregistered tools', () => {
  const project = createRootToolEventProjector({ requestId: 'req-1' });

  const started = project(toolEvent({
    event: 'tool-started',
    tool_call_id: 'call-4',
    tool_name: 'mystery_tool',
    input: {},
  }, ['capability:c1', 'tools:t9']));
  assert.ok(started);
  assert.equal(started.operation.operation.title, 'mystery_tool');
  assert.equal(started.operation.operation.kind, 'runtime.mystery_tool');
  assert.deepEqual(started.namespace, ['capability:c1', 'tools:t9']);
});
