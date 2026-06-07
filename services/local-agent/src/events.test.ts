import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildToolOperationEvent } from './agentStreamEvents';
import { normalizeToolStreamEvent } from './events/agentStreamNormalizer';
import { createOperationRegistry } from './events/operationRegistry';
import { createBrowserToolkit } from './toolkits/browser';
import { createBashToolkit, createGitToolkit, localToolOperationRegistry } from './toolkits/local';
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
      kind: 'bash.read_file',
      title: '析文档',
      target: '/tmp/example.md',
      summary: undefined,
      details: undefined,
      source: {
        provider: 'toolkit',
        name: 'bash',
        toolName: 'read_file',
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
  assert.equal(event.operation.kind, 'runtime.unknown_tool');
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
        title: 'Capability Shell',
        summarizeInput: () => ({
          target: 'custom-target',
          summary: 'custom summary',
        }),
        source: {
          provider: 'toolset',
          name: 'private_shell',
          toolName: 'run_shell',
        },
      },
    },
    localToolOperationRegistry,
  );

  assert.equal(event.operation.kind, 'private_shell.run_shell');
  assert.equal(event.operation.title, 'Capability Shell');
  assert.equal(event.operation.target, 'custom-target');
  assert.equal(event.operation.summary, 'custom summary');
  assert.deepEqual(event.operation.source, {
    provider: 'toolset',
    name: 'private_shell',
    toolName: 'run_shell',
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
  assert.equal(event.operation.kind, 'runtime.run_shell');
  assert.equal(event.operation.title, 'run_shell');
  assert.deepEqual(event.operation.source, {
    provider: 'runtime',
    name: 'runtime',
    toolName: 'run_shell',
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
  assert.equal(event.operation.kind, 'bash.run_shell');
  assert.equal(event.operation.title, '执行命令');
  assert.equal(event.operation.target, '/repo');
  assert.equal(event.operation.summary, 'git status --short');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'run_shell',
    callId: 'call-1',
  });
});

test('buildToolOperationEvent uses git toolkit metadata', () => {
  const event = buildToolOperationEvent('req-1', {
    event: 'on_tool_start',
    name: 'git_commit',
    toolCallId: 'call-1',
    input: { message: 'test: update toolkit boundaries', cwd: '/repo' },
  }, localToolOperationRegistry);

  assert.equal(event.type, 'operation');
  assert.equal(event.phase, 'started');
  assert.equal(event.operation.kind, 'git.git_commit');
  assert.equal(event.operation.title, '创建 git commit');
  assert.equal(event.operation.target, '/repo');
  assert.equal(event.operation.summary, 'test: update toolkit boundaries');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'git',
    toolName: 'git_commit',
    callId: 'call-1',
  });
});

test('createBashToolkit exposes operation metadata with the toolkit definition', () => {
  const toolkit = createBashToolkit();

  assert.equal(toolkit.operations?.read_file?.title, '析文档');
  assert.equal(toolkit.operations?.grep_search?.title, '搜内容');
  assert.equal(toolkit.operations?.run_shell?.title, '执行命令');
  assert.equal(toolkit.operations?.git_status, undefined);
});

test('createGitToolkit exposes git operation metadata with the toolkit definition', () => {
  const toolkit = createGitToolkit();

  assert.equal(toolkit.operations?.git_status?.title, '查看 git 状态');
  assert.equal(toolkit.operations?.git_commit?.title, '创建 git commit');
  assert.equal(Boolean(toolkit.policy?.toolReview?.git_commit), true);
});

test('createBrowserToolkit exposes browser operation metadata', () => {
  const toolkit = createBrowserToolkit();

  assert.equal(toolkit.operations?.browser_open?.title, '打开网页');
  assert.equal(toolkit.operations?.browser_click?.title, '点击页面');
  assert.equal(toolkit.operations?.browser_type?.title, '输入文本');
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

  assert.equal(event.operation.kind, 'browser.browser_open');
  assert.equal(event.operation.title, '打开网页');
  assert.equal(event.operation.target, 'https://example.com/');
  assert.equal(event.operation.summary, '页面：Example Domain');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'browser',
    toolName: 'browser_open',
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

  assert.equal(event.operation.kind, 'browser.browser_type');
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

  assert.equal(event.operation.kind, 'test-toolkit.custom_tool');
  assert.equal(event.operation.title, 'Custom Run');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'test-toolkit',
    toolName: 'custom_tool',
    callId: undefined,
  });
});

test('createOperationRegistryForAgentSetup reads host tool metadata from setup toolkits', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [{
        name: 'fake_pet_profile',
        description: 'Fake toolkit for registry coverage.',
        operations: {
          describe_pet_profile: {
            title: '读取宠物资料',
            summarizeInput: (input: unknown) => {
              const focus = input && typeof input === 'object' && 'focus' in input
                ? (input as { focus?: unknown }).focus
                : null;
              return typeof focus === 'string'
                ? { target: focus, summary: `查看 ${focus}` }
                : null;
            },
          },
        },
      }],
    },
  } as never);

  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'describe_pet_profile',
      input: { focus: '性格' },
    },
    registry,
  );

  assert.equal(event.operation.kind, 'fake_pet_profile.describe_pet_profile');
  assert.equal(event.operation.title, '读取宠物资料');
  assert.equal(event.operation.target, '性格');
  assert.equal(event.operation.summary, '查看 性格');
  assert.deepEqual(event.operation.source, {
    provider: 'toolkit',
    name: 'fake_pet_profile',
    toolName: 'describe_pet_profile',
    callId: undefined,
  });
});

test('file tool metadata includes before/after snapshots', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-file-op-meta-'));
  const filePath = resolve(root, 'note.txt');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(filePath, 'alpha\nbeta\n', 'utf-8');

  const startEvent = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'write_file',
      toolCallId: 'call-1',
      input: {
        path: filePath,
        content: 'alpha\nbeta\ngamma\n',
      },
    },
    localToolOperationRegistry,
  );

  assert.equal(startEvent.operation.target, filePath);
  assert.equal(startEvent.operation.details?.before, 'alpha\nbeta\n');

  writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf-8');
  const endEvent = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'write_file',
      toolCallId: 'call-1',
      output: {
        ok: true,
        path: filePath,
        mode: 'write',
      },
    },
    localToolOperationRegistry,
  );

  assert.equal(endEvent.operation.details?.after, 'alpha\nbeta\ngamma\n');
  assert.equal(endEvent.operation.target, filePath);
});
