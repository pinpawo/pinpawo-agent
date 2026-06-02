import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolOperationEvent } from './agentStreamEvents';
import { normalizeToolStreamEvent } from './events/agentStreamNormalizer';
import { createOperationRegistry } from './events/operationRegistry';
import { createBrowserToolkit } from './capabilities/browserCapability';
import { createBashToolkit, localToolOperationRegistry } from './plugins/localTools';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';

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

test('normalizes tool stream events with event-provided operation metadata first', () => {
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'run_shell',
      toolCallId: 'call-1',
      input: { command: 'git status' },
      operation: {
        kind: 'capability.shell_alias',
        title: 'Capability Shell',
        summarizeInput: () => ({
          target: 'custom-target',
          summary: 'custom summary',
        }),
        source: {
          provider: 'capability',
          name: 'run_shell',
        },
      },
    },
    localToolOperationRegistry,
  );

  assert.equal(event.operation.kind, 'capability.shell_alias');
  assert.equal(event.operation.title, 'Capability Shell');
  assert.equal(event.operation.target, 'custom-target');
  assert.equal(event.operation.summary, 'custom summary');
  assert.deepEqual(event.operation.source, {
    provider: 'capability',
    name: 'run_shell',
    callId: 'call-1',
  });
});

test('buildToolOperationEvent defaults to generic runtime operations', () => {
  const event = buildToolOperationEvent('req-1', {
    event: 'on_tool_start',
    name: 'run_shell',
    toolCallId: 'call-1',
    input: { command: 'git status --short', cwd: '/repo' },
  });

  assert.equal(event.type, 'operation');
  assert.equal(event.phase, 'started');
  assert.equal(event.operation.kind, 'tool.execute');
  assert.equal(event.operation.title, 'run_shell');
  assert.deepEqual(event.operation.source, {
    provider: 'runtime',
    name: 'run_shell',
    callId: 'call-1',
  });
});

test('buildToolOperationEvent uses explicit toolkit metadata', () => {
  const event = buildToolOperationEvent('req-1', {
    event: 'on_tool_start',
    name: 'run_shell',
    toolCallId: 'call-1',
    input: { command: 'git status --short', cwd: '/repo' },
  }, localToolOperationRegistry);

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

test('createBrowserToolkit exposes browser operation metadata', () => {
  const toolkit = createBrowserToolkit();

  assert.equal(toolkit.operations?.browser_open?.kind, 'browser.open');
  assert.equal(toolkit.operations?.browser_click?.kind, 'browser.click');
  assert.equal(toolkit.operations?.browser_type?.kind, 'browser.type');
});

test('browser operation metadata summarizes page output', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [createBrowserToolkit()],
    },
  } as never);

  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'browser_open',
      toolCallId: 'call-1',
      input: { url: 'https://example.com', headless: true },
      output: JSON.stringify({
        title: 'Example Domain',
        url: 'https://example.com/',
        text: 'Example text',
      }),
    },
    registry,
  );

  assert.equal(event.operation.kind, 'browser.open');
  assert.equal(event.operation.title, '打开网页');
  assert.equal(event.operation.target, 'https://example.com/');
  assert.equal(event.operation.summary, '页面：Example Domain');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'browser_open',
    callId: 'call-1',
  });
});

test('browser type operation metadata does not expose typed text in display fields', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [createBrowserToolkit()],
    },
  } as never);

  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'browser_type',
      input: {
        selector: '#password',
        text: 'super-secret-token',
        submit: true,
      },
    },
    registry,
  );

  assert.equal(event.operation.kind, 'browser.type');
  assert.equal(event.operation.target, '#password');
  assert.equal(event.operation.summary, '输入到 #password');
  assert.deepEqual(event.operation.details, {
    selector: '#password',
    submit: true,
    textLength: 'super-secret-token'.length,
  });
  assert.equal(JSON.stringify(event.operation).includes('super-secret-token'), false);
});

test('createOperationRegistryForAgentSetup reads operation metadata from setup toolkits', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [{
        name: 'test-toolkit',
        operations: {
          custom_tool: {
            kind: 'custom.run',
            title: 'Custom Run',
          },
        },
      }],
    },
  } as never);

  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'custom_tool',
      input: {},
    },
    registry,
  );

  assert.equal(event.operation.kind, 'custom.run');
  assert.equal(event.operation.title, 'Custom Run');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'custom_tool',
    callId: undefined,
  });
});
