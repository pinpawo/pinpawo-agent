import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolOperationEvent } from './agentStreamEvents';
import { normalizeToolStreamEvent } from './events/agentStreamNormalizer';
import { createOperationRegistry } from './events/operationRegistry';
import { createBashToolkit, localToolOperationRegistry } from './plugins/localTools';

test('normalizes LangGraph tool stream events with toolkit operation metadata', () => {
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'read_file',
      toolCallId: 'call-1',
      input: { path: '/tmp/example.md' },
    },
    localToolOperationRegistry,
  );

  assert.deepEqual(event, {
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      id: 'call-1',
      kind: 'file.read',
      title: '读文件',
      target: '/tmp/example.md',
      summary: undefined,
      details: undefined,
      source: {
        provider: 'toolkit',
        name: 'read_file',
        callId: 'call-1',
      },
    },
    raw: {
      input: { path: '/tmp/example.md' },
      output: undefined,
      error: undefined,
    },
  });
});

test('falls back to a generic operation when no metadata is registered', () => {
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'unknown_tool',
      output: 'done',
    },
    createOperationRegistry(),
  );

  assert.equal(event.phase, 'completed');
  assert.equal(event.operation.kind, 'tool.execute');
  assert.equal(event.operation.title, 'unknown_tool');
  assert.equal(event.operation.source?.provider, 'runtime');
});

test('buildToolOperationEvent uses local toolkit metadata for direct event emission', () => {
  const event = buildToolOperationEvent('req-1', {
    event: 'on_tool_start',
    name: 'run_shell',
    toolCallId: 'call-1',
    input: { command: 'git status --short', cwd: '/repo' },
  });

  assert.equal(event.type, 'operation');
  assert.equal(event.phase, 'started');
  assert.equal(event.operation.kind, 'shell.run');
  assert.equal(event.operation.title, '执行命令');
  assert.equal(event.operation.target, '/repo');
  assert.equal(event.operation.summary, 'git status --short');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'run_shell',
    callId: 'call-1',
  });
});

test('createBashToolkit exposes operation metadata with the toolkit definition', () => {
  const toolkit = createBashToolkit();

  assert.equal(toolkit.operations?.read_file?.kind, 'file.read');
  assert.equal(toolkit.operations?.grep_search?.kind, 'search.grep');
  assert.equal(toolkit.operations?.run_shell?.kind, 'shell.run');
});
