import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentContextPolicy, SubagentToolOperationMetadata } from '../types/subagent';
import { rewriteMessagesForContextPolicy } from './contextPolicy';

function toolCallMessage(id: string, name: string, args: Record<string, unknown>) {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name, args }],
  });
}

function toolResult(id: string, content: string, fields: Partial<ToolMessage> = {}) {
  return new ToolMessage({
    content,
    tool_call_id: id,
    status: fields.status,
    name: fields.name,
  });
}

function ctx(operations: Record<string, SubagentToolOperationMetadata>) {
  return {
    iterationCount: 1,
    operations,
    contextWindowTokens: 1000,
  };
}

test('context policy evicts old large successful tool results only', () => {
  const operations = {
    view_file_chunk: {
      summarizeInput: (input: unknown) => {
        const record = input as { path?: string; startLine?: number; endLine?: number };
        return {
          target: record.path,
          summary: `${record.startLine ?? 1}-${record.endLine ?? ''}`,
        };
      },
    },
    run_shell: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [
    new HumanMessage('inspect files'),
    toolCallMessage('call-old', 'view_file_chunk', { path: 'src/a.ts', startLine: 1, endLine: 200 }),
    toolResult('call-old', `old large file output\n${'x'.repeat(2600)}`),
    new AIMessage('important note stays'),
    toolCallMessage('call-small', 'view_file_chunk', { path: 'src/small.ts' }),
    toolResult('call-small', 'small output'),
    toolCallMessage('call-error', 'view_file_chunk', { path: 'src/missing.ts' }),
    toolResult('call-error', 'Error: no such file', { status: 'error' }),
    toolCallMessage('call-unknown', 'run_shell', { command: 'cat src/a.ts' }),
    toolResult('call-unknown', `unknown large output\n${'y'.repeat(2600)}`),
    toolCallMessage('call-recent', 'view_file_chunk', { path: 'src/recent.ts' }),
    toolResult('call-recent', `recent large output\n${'z'.repeat(2600)}`),
  ];
  const policy: SubagentContextPolicy = {
    evictToolResults: {
      keepRecent: 1,
      minSizeChars: 2000,
      keepFailures: true,
      perTool: {
        run_shell: 'keep',
      },
    },
  };

  const rewritten = rewriteMessagesForContextPolicy(messages, policy, ctx(operations));

  assert.match(String(rewritten[2]?.content), /^\[evicted: view_file_chunk src\/a\.ts 1-200 -> 已读；需要时重新调用\]$/);
  assert.equal(rewritten[3]?.content, 'important note stays');
  assert.equal(rewritten[5]?.content, 'small output');
  assert.equal(rewritten[7]?.content, 'Error: no such file');
  assert.match(String(rewritten[9]?.content), /^unknown large output/);
  assert.match(String(rewritten[11]?.content), /^recent large output/);
});

test('context policy executor does not own the provider input-token trigger', () => {
  const operations = {
    view_file_chunk: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [
    new HumanMessage('inspect files'),
    toolCallMessage('call-old', 'view_file_chunk', { path: 'src/a.ts' }),
    toolResult('call-old', `old large file output\n${'x'.repeat(2600)}`),
    toolCallMessage('call-new', 'view_file_chunk', { path: 'src/b.ts' }),
    toolResult('call-new', `new large file output\n${'y'.repeat(2600)}`),
  ];

  const rewritten = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 0,
      minSizeChars: 2000,
    },
  }, ctx(operations));

  assert.match(String(rewritten[2]?.content), /^\[evicted:/);
  assert.match(String(rewritten[4]?.content), /^\[evicted:/);
});

test('context policy perTool keep and truncate override default eviction mode', () => {
  const operations = {
    view_file_chunk: {},
    http_fetch: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-keep', 'view_file_chunk', { path: 'src/a.ts' }),
    toolResult('call-keep', `keep me\n${'x'.repeat(2600)}`),
    toolCallMessage('call-truncate', 'http_fetch', { url: 'https://example.com' }),
    toolResult('call-truncate', `truncate me\n${'y'.repeat(2600)}`),
  ];

  const rewritten = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 0,
      minSizeChars: 80,
      perTool: {
        view_file_chunk: 'keep',
        http_fetch: 'truncate',
      },
    },
  }, ctx(operations));

  assert.equal(rewritten[2]?.content, messages[2]?.content);
  assert.match(String(rewritten[4]?.content), /^truncate me/);
  assert.match(String(rewritten[4]?.content), /\[truncated: older tool result; recall or rerun tool if needed\]$/);
  assert.ok(String(rewritten[4]?.content).length < String(messages[4]?.content).length);
});

test('context policy perTool evict overrides failure protections but not recency', () => {
  const operations = {
    run_shell: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-error', 'run_shell', { command: 'cat missing' }),
    toolResult('call-error', 'Error: small failure', { status: 'error' }),
    toolCallMessage('call-recent', 'run_shell', { command: 'cat recent' }),
    toolResult('call-recent', `recent failure\n${'y'.repeat(2600)}`, { status: 'error' }),
  ];

  const rewritten = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 1,
      minSizeChars: 2000,
      keepFailures: true,
      perTool: {
        run_shell: 'evict',
      },
    },
  }, ctx(operations));

  assert.match(String(rewritten[2]?.content), /^\[evicted: run_shell \{"command":"cat missing"\} -> 已读；需要时重新调用\]$/);
  assert.equal(rewritten[4]?.content, messages[4]?.content);
});

test('context policy keeps recent tool results while evicting older matches', () => {
  const operations = {
    view_file_chunk: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-old', 'view_file_chunk', { path: 'src/old.ts' }),
    toolResult('call-old', `old\n${'x'.repeat(2600)}`),
    toolCallMessage('call-new', 'view_file_chunk', { path: 'src/new.ts' }),
    toolResult('call-new', `new\n${'y'.repeat(2600)}`),
  ];

  const rewritten = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 1,
      minSizeChars: 2000,
    },
  }, ctx(operations));

  assert.match(String(rewritten[2]?.content), /^\[evicted: view_file_chunk \{"path":"src\/old\.ts"\} -> 已读；需要时重新调用\]$/);
  assert.equal(rewritten[4]?.content, messages[4]?.content);
});

test('context policy default truncate preserves older tool result prefixes while shortening content', () => {
  const operations = {
    view_file_chunk: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-old', 'view_file_chunk', { path: 'src/old.ts' }),
    toolResult('call-old', `old evidence line\n${'x'.repeat(2600)}`),
    toolCallMessage('call-new', 'view_file_chunk', { path: 'src/new.ts' }),
    toolResult('call-new', `new evidence line\n${'y'.repeat(2600)}`),
  ];

  const rewritten = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 1,
      defaultMode: 'truncate',
      minSizeChars: 80,
    },
  }, ctx(operations));

  assert.match(String(rewritten[2]?.content), /^old evidence line/);
  assert.match(String(rewritten[2]?.content), /\[truncated: older tool result; recall or rerun tool if needed\]$/);
  assert.doesNotMatch(String(rewritten[2]?.content), /^\[evicted:/);
  assert.equal(rewritten[4]?.content, messages[4]?.content);
});

test('context policy rewrites thirty read-heavy tool results while preserving recent floor', () => {
  const operations = {
    view_file_chunk: {
      summarizeInput: (input: unknown) => {
        const record = input as { path?: string };
        return { target: record.path };
      },
    },
  } satisfies Record<string, SubagentToolOperationMetadata>;
  const messages: BaseMessage[] = [new HumanMessage('inspect many files')];
  for (let i = 0; i < 30; i += 1) {
    const id = `call-${i}`;
    messages.push(
      toolCallMessage(id, 'view_file_chunk', { path: `src/file-${i}.ts` }),
      toolResult(id, `file ${i}\n${'x'.repeat(2600)}`),
    );
  }

  const rewritten = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 5,
      minSizeChars: 2_000,
      keepFailures: true,
    },
  }, ctx(operations));
  const toolResults = rewritten.filter((message) => ToolMessage.isInstance(message));
  const fullResults = toolResults.filter((message) => String(message.content).startsWith('file '));
  const stubs = toolResults.filter((message) => String(message.content).startsWith('[evicted:'));

  assert.equal(toolResults.length, 30);
  assert.equal(fullResults.length, 5);
  assert.equal(stubs.length, 25);
  assert.deepEqual(fullResults.map((message) => String(message.content).split('\n')[0]), [
    'file 25',
    'file 26',
    'file 27',
    'file 28',
    'file 29',
  ]);
  assert.ok(String(stubs[0]?.content ?? '').startsWith('[evicted:'));
});

test('context policy is a no-op when a capability does not declare one', () => {
  const messages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-1', 'view_file_chunk', { path: 'src/a.ts' }),
    toolResult('call-1', `large\n${'x'.repeat(2600)}`),
  ];

  const rewritten = rewriteMessagesForContextPolicy(messages, undefined, ctx({
    view_file_chunk: {},
  }));

  assert.equal(rewritten, messages);
  assert.deepEqual(rewritten.map((message) => message.content), messages.map((message) => message.content));
});

test('context policy rewrite escape hatch', () => {
  const messages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-1', 'grep_search', { query: 'needle' }),
    toolResult('call-1', `large grep output\n${'x'.repeat(2600)}`),
  ];

  const escapeHatch = rewriteMessagesForContextPolicy(messages, {
    evictToolResults: {
      keepRecent: 0,
    },
    rewrite: () => [new HumanMessage('rewritten directly')],
  }, ctx({ grep_search: {} }));
  assert.deepEqual(escapeHatch.map((message) => message.content), ['rewritten directly']);
});

test('context policy does not rewrite evicted stubs or truncated results again', () => {
  const evictMessages: BaseMessage[] = [
    new HumanMessage('inspect'),
    toolCallMessage('call-1', 'grep_search', { query: 'needle' }),
    toolResult('call-1', `large grep output\n${'x'.repeat(2600)}`),
  ];
  const operations = {
    grep_search: {},
    http_fetch: {},
  } satisfies Record<string, SubagentToolOperationMetadata>;

  const once = rewriteMessagesForContextPolicy(evictMessages, {
    evictToolResults: {
      keepRecent: 0,
      minSizeChars: 1,
    },
  }, ctx(operations));
  const twice = rewriteMessagesForContextPolicy(once, {
    evictToolResults: {
      keepRecent: 0,
      minSizeChars: 1,
    },
  }, ctx(operations));

  assert.equal(once[2]?.content, '[evicted: grep_search {"query":"needle"} -> 已读；需要时重新调用]');
  assert.equal(twice[2]?.content, once[2]?.content);

  const truncMessages: BaseMessage[] = [
    new HumanMessage('fetch'),
    toolCallMessage('call-2', 'http_fetch', { url: 'https://example.com' }),
    toolResult('call-2', `abcdef\n${'y'.repeat(2600)}`),
  ];
  const truncatedOnce = rewriteMessagesForContextPolicy(truncMessages, {
    evictToolResults: {
      keepRecent: 0,
      minSizeChars: 3,
      perTool: { http_fetch: 'truncate' },
    },
  }, ctx(operations));
  const truncatedTwice = rewriteMessagesForContextPolicy(truncatedOnce, {
    evictToolResults: {
      keepRecent: 0,
      minSizeChars: 3,
      perTool: { http_fetch: 'truncate' },
    },
  }, ctx(operations));

  assert.equal(truncatedTwice[2]?.content, truncatedOnce[2]?.content);
});
