import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { buildToolOperationEvent } from './agentStreamEvents';
import { normalizeToolStreamEvent } from './events/agentStreamNormalizer';
import {
  createOperationRegistry,
  createOperationRegistryFromToolkits,
} from './events/operationRegistry';
import { createBrowserToolkit } from '@pinpawo-toolkit/browser';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

const localToolOperationRegistry = createOperationRegistryFromToolkits([
  createBashToolkit(),
  createGitToolkit(),
]);

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

test('marks structured ok=false tool output as a failed operation', () => {
  const output = JSON.stringify({
    ok: false,
    code: 'context_not_found',
    message: 'Patch context did not match.',
  });
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'apply_patch',
      toolCallId: 'call-1',
      output,
    },
    localToolOperationRegistry,
  );

  assert.equal(event.phase, 'failed');
  assert.equal(event.raw?.output, output);
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
          provider: 'toolkit',
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
    provider: 'toolkit',
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

test('normalizes an incomplete run_shell start without interrupting the run', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => warnings.push(String(message));
  let event;
  try {
    event = normalizeToolStreamEvent(
      'req-1',
      {
        event: 'on_tool_start',
        name: 'run_shell',
        toolCallId: 'call-1',
        input: {},
      },
      localToolOperationRegistry,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(event?.phase, 'started');
  assert.equal(event?.operation.title, '执行命令');
  assert.equal(event?.operation.target, undefined);
  assert.equal(event?.operation.summary, undefined);
  assert.deepEqual(event?.raw?.input, {});
  assert.deepEqual(warnings, [
    '[agent-stream] omitted input summary for run_shell; input was incomplete or invalid',
  ]);
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

  assert.equal(definition(toolkit, 'read_file')?.operation?.title, '析文档');
  assert.equal(definition(toolkit, 'grep_search')?.operation?.title, '搜内容');
  assert.equal(definition(toolkit, 'run_shell')?.operation?.title, '执行命令');
  assert.equal(definition(toolkit, 'git_status'), undefined);
});

test('createGitToolkit exposes git operation metadata with the toolkit definition', () => {
  const toolkit = createGitToolkit();

  assert.equal(definition(toolkit, 'git_status')?.operation?.title, '查看 git 状态');
  assert.equal(definition(toolkit, 'git_commit')?.operation?.title, '创建 git commit');
  assert.equal(Boolean(definition(toolkit, 'git_add')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'git_commit')?.review), true);
  assert.match(toolkit.reviewGuidance?.allow ?? '', /normal non-force push/);
  assert.match(toolkit.reviewGuidance?.ask ?? '', /force pushes/);
});

test('createBashToolkit exposes shell auto-review risk context', () => {
  const toolkit = createBashToolkit();

  assert.match(toolkit.reviewGuidance?.allow ?? '', /build, test, typecheck, lint, format/);
  assert.match(toolkit.reviewGuidance?.allow ?? '', /deletion of explicitly named non-sensitive/);
  assert.match(toolkit.reviewGuidance?.ask ?? '', /deletes recursively/);
  assert.match(toolkit.reviewGuidance?.ask ?? '', /deletes user data or sensitive files/);
  assert.match(toolkit.reviewGuidance?.ask ?? '', /elevates privileges/);
  assert.match(toolkit.reviewGuidance?.ask ?? '', /publishes or deploys artifacts/);
});

test('createBrowserToolkit exposes browser operation metadata', () => {
  const toolkit = createBrowserToolkit();

  assert.equal(definition(toolkit, 'browser_open')?.operation?.title, '打开网页');
  assert.equal(definition(toolkit, 'browser_click')?.operation?.title, '点击页面');
  assert.equal(definition(toolkit, 'browser_type')?.operation?.title, '输入文本');
  assert.equal(Boolean(definition(toolkit, 'browser_open')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'browser_open_with_session')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'browser_open_with_profile')?.review), true);
  assert.equal(definition(toolkit, 'browser_click')?.review, undefined);
  assert.equal(definition(toolkit, 'browser_type')?.review, undefined);
  assert.equal(definition(toolkit, 'browser_snapshot')?.review, undefined);
  assert.equal(definition(toolkit, 'browser_extract')?.review, undefined);
  assert.equal(definition(toolkit, 'browser_wait')?.review, undefined);
});

test('browser open review policy offers session authorization', async () => {
  const toolkit = createBrowserToolkit();
  const policy = definition(toolkit, 'browser_open')?.review;
  assert.ok(policy);
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const matcher = await buildMatcher({
    toolkitName: 'browser',
    toolName: 'browser_open',
    input: { url: 'https://Example.test/path', headless: true },
    operation: definition(toolkit, 'browser_open')?.operation,
  });

  const review = await policy.request({
    toolkitName: 'browser',
    toolName: 'browser_open',
    input: { url: 'https://example.test', headless: true },
    operation: definition(toolkit, 'browser_open')?.operation,
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
    authorizationMatcher: matcher,
  });

  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );

  assert.deepEqual(
    matcher,
    { type: 'url_origin', origin: 'https://example.test' },
  );
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

test('browser operation metadata parses JSON-string inputs for input summaries', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [createBrowserToolkit()],
    },
  } as never);

  const started = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'browser_click',
      toolCallId: 'call-1',
      input: '{"selector":".login-btn"}',
    },
    registry,
  );

  assert.equal(started.operation.summary, '点击 .login-btn');

  const startFromOpen = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_start',
      name: 'browser_open',
      toolCallId: 'call-2',
      input: '{"url":"https://example.com","headless":true}',
    },
    registry,
  );

  assert.equal(startFromOpen.operation.target, 'https://example.com');
  assert.equal(startFromOpen.operation.summary, '打开网页');
  assert.equal(startFromOpen.operation.details?.headless, true);
});

test('tool operation output summaries still receive raw output strings first', () => {
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'submit_plan',
      toolCallId: 'call-1',
      output: '{"taskCount":2}',
      operation: {
        title: '提交计划',
        summarizeOutput: (output: unknown) => {
          if (typeof output !== 'string') return null;
          const parsed = JSON.parse(output) as { taskCount?: unknown };
          return typeof parsed.taskCount === 'number'
            ? { summary: `已接收 ${parsed.taskCount} 个任务` }
            : null;
        },
      },
    },
    createOperationRegistry(),
  );

  assert.equal(event.operation.summary, '已接收 2 个任务');
});

test('unwraps a live ToolMessage instance to its content string (no LangChain envelope)', () => {
  // LangChain streamMode:'tools' emits on_tool_end with output set to the full
  // ToolMessage instance; without unwrapping, raw.output is the serialized envelope.
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'http_fetch',
      toolCallId: 'call-1',
      output: new ToolMessage({
        content: '{"title":"issue 269","state":"open"}',
        tool_call_id: 'call-1',
        name: 'http_fetch',
      }),
    },
    createOperationRegistry(),
  );

  assert.equal(event.raw?.output, '{"title":"issue 269","state":"open"}');
});

test('unwraps a serialized ToolMessage ({lc,...,kwargs.content}) form', () => {
  // The form seen in LangSmith traces / after checkpoint round-trips: not a live
  // instance, content lives under kwargs.content.
  const serialized = JSON.parse(JSON.stringify(new ToolMessage({
    content: 'serialized body',
    tool_call_id: 'call-1',
    name: 'http_fetch',
  })));

  const event = normalizeToolStreamEvent(
    'req-1',
    { event: 'on_tool_end', name: 'http_fetch', toolCallId: 'call-1', output: serialized },
    createOperationRegistry(),
  );

  assert.equal(event.raw?.output, 'serialized body');
});

test('unwraps array-content ToolMessage output by concatenating text parts', () => {
  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'http_fetch',
      toolCallId: 'call-1',
      output: new ToolMessage({
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
        tool_call_id: 'call-1',
        name: 'http_fetch',
      }),
    },
    createOperationRegistry(),
  );

  assert.equal(event.raw?.output, 'hello world');
});

test('leaves plain string and plain record tool outputs untouched', () => {
  const stringEvent = normalizeToolStreamEvent(
    'req-1',
    { event: 'on_tool_end', name: 'run_shell', toolCallId: 'c1', output: 'plain' },
    createOperationRegistry(),
  );
  assert.equal(stringEvent.raw?.output, 'plain');

  // A tool that legitimately returns an object with a `content` key but is not a
  // message must not be unwrapped.
  const recordOutput = { content: 'not a message', other: 1 };
  const recordEvent = normalizeToolStreamEvent(
    'req-1',
    { event: 'on_tool_end', name: 'custom', toolCallId: 'c2', output: recordOutput },
    createOperationRegistry(),
  );
  assert.deepEqual(recordEvent.raw?.output, recordOutput);
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
      input: JSON.stringify({
        selector: '#password',
        text: 'super-secret-token',
        submit: true,
      }),
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

test('browser operation metadata accepts JSON string input and raw string output', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [createBrowserToolkit()],
    },
  } as never);

  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_end',
      name: 'browser_wait',
      toolCallId: 'call-1',
      input: JSON.stringify({
        selector: '#result',
        timeoutMs: 5000,
      }),
      output: '页面稳定，结果已出现',
    },
    registry,
  );

  assert.equal(event.operation.kind, 'browser.browser_wait');
  assert.equal(event.operation.title, '等待页面');
  assert.equal(event.operation.target, '#result');
  assert.equal(event.operation.summary, '页面稳定，结果已出现');
  assert.deepEqual(event.operation.details, {
    selector: '#result',
    timeoutMs: 5000,
  });
});

test('browser operation metadata summarizes failed events without raw payload display', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [createBrowserToolkit()],
    },
  } as never);

  const event = normalizeToolStreamEvent(
    'req-1',
    {
      event: 'on_tool_error',
      name: 'browser_click',
      toolCallId: 'call-1',
      input: JSON.stringify({ selector: 'text=登录' }),
      error: new Error('No active browser page. Use browser_open first.'),
    },
    registry,
  );

  assert.equal(event.phase, 'failed');
  assert.equal(event.operation.target, 'text=登录');
  assert.equal(event.operation.summary, 'No active browser page. Use browser_open first.');
  assert.deepEqual(event.operation.details, { selector: 'text=登录' });
});

test('createOperationRegistryForAgentSetup reads operation metadata from setup toolkits', () => {
  const registry = createOperationRegistryForAgentSetup({
    input: {
      toolkits: [{
        name: 'test-toolkit',
        description: 'Test toolkit.',
        tools: [{
          tool: { name: 'custom_tool' } as never,
          operation: {
            title: 'Custom Run',
          },
        }],
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
        tools: [{
          tool: { name: 'describe_pet_profile' } as never,
          operation: {
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
        }],
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
