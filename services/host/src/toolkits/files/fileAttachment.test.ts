import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatPromptValue } from '@langchain/core/prompt_values';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { convertMessagesToCompletionsMessageParams, convertMessagesToResponsesInput } from '@langchain/openai';
import { convertPromptToAnthropic } from '@langchain/anthropic';
import { END, isCommand, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { createSubagent, type ModelInputModality } from '@pinpawo/pet-agent';
import { toolProtocolMiddleware } from '../../../../../packages/pet-agent/src/agent/orchestrator/modelInvocation';
import { createFilesToolkit } from './index';
import { MAX_FILE_ATTACHMENT_BYTES, MAX_FILE_ATTACHMENT_TOTAL_BYTES, readFileTool } from './fileAttachment';

const fixtures = {
  'image.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'),
  'image.webp': Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'),
  'image.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  'document.pdf': Buffer.from('%PDF-1.4\n% native bytes, not extracted text\n%%EOF'),
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'pinpawo-file-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(fixtures)) await writeFile(resolve(root, name), bytes);
  return root;
}

function config(workdir: string, modelInputModalities: readonly ModelInputModality[] = ['text', 'image', 'file'], extra = {}) {
  return { context: { executionScope: { threadId: 'thread', taskId: 'task', runId: 'run', delegationId: 'delegation', workdir },
    modelInputModalities, ...extra },
  state: { messages: [new AIMessage({ content: '', tool_calls: [{ id: 'read-1', name: 'read_file', args: {} }] })] },
  toolCallId: 'read-1', toolCall: { id: 'read-1', name: 'read_file', args: {} } };
}

async function attach(root: string, path: string, modalities?: readonly ModelInputModality[], extra?: Record<string, unknown>) {
  return readFileTool.invoke({ path }, config(root, modalities, extra) as never);
}

function messages(output: unknown): BaseMessage[] {
  assert.ok(isCommand(output));
  return (output.update as { messages: BaseMessage[] }).messages;
}

function failure(output: unknown) {
  assert.equal(isCommand(output), false);
  const content = ToolMessage.isInstance(output) ? output.content : output;
  const value = JSON.parse(String(content)) as { ok: boolean; code: string; message: string };
  assert.equal(value.ok, false);
  return value;
}

for (const [filename, bytes] of Object.entries(fixtures)) {
  test(`read_file attaches exact ${filename} bytes as a standard HumanMessage`, async (t) => {
    const root = await fixture(t);
    const [result, attachment] = messages(await attach(root, filename));
    assert.ok(ToolMessage.isInstance(result));
    assert.equal(result.tool_call_id, 'read-1');
    assert.ok(HumanMessage.isInstance(attachment));
    assert.equal(attachment.response_metadata.output_version, 'v1');
    const block = attachment.contentBlocks[1];
    assert.equal(block?.type, filename.endsWith('pdf') ? 'file' : 'image');
    assert.equal(block?.data, bytes.toString('base64'));
    assert.equal(block?.metadata?.filename, filename);
    assert.equal(JSON.parse(String(result.content)).byteLength, bytes.length);
    assert.doesNotMatch(String(result.content), /base64|native bytes/);
  });
}

test('file attachments survive all three public provider converters with tool-call linkage', async (t) => {
  const root = await fixture(t);
  for (const filename of ['image.png', 'image.jpg', 'image.webp', 'document.pdf']) {
    const payload = messages(await attach(root, filename));
    const data = fixtures[filename as keyof typeof fixtures].toString('base64');
    const mime = filename.endsWith('pdf') ? 'application/pdf' : filename.endsWith('png') ? 'image/png' : filename.endsWith('webp') ? 'image/webp' : 'image/jpeg';
    const completions = convertMessagesToCompletionsMessageParams({ messages: payload });
    const responses = convertMessagesToResponsesInput({ messages: payload, model: 'gpt-5.5', zdrEnabled: false });
    const anthropic = convertPromptToAnthropic(new ChatPromptValue({ messages: payload }));
    assert.equal((completions[0] as { tool_call_id: string }).tool_call_id, 'read-1');
    assert.equal((responses[0] as { call_id: string }).call_id, 'read-1');
    const cc = (completions[1] as { content: unknown[] }).content;
    const rr = (responses[1] as { content: unknown[] }).content;
    const aa = anthropic.messages[1]!.content as unknown[];
    assert.doesNotMatch(JSON.stringify({ completions, responses, anthropic }), /toolResultAttachmentCallId/);
    if (mime === 'application/pdf') {
      assert.deepEqual(cc[1], { type: 'file', file: { file_data: `data:${mime};base64,${data}`, filename } });
      assert.deepEqual(rr[1], { type: 'input_file', file_data: `data:${mime};base64,${data}`, filename });
      assert.deepEqual(aa[1], { type: 'document', source: { type: 'base64', media_type: mime, data } });
    } else {
      assert.deepEqual(cc[1], { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
      assert.deepEqual(rr[1], { type: 'input_image', detail: 'auto', image_url: `data:${mime};base64,${data}` });
      assert.deepEqual(aa[1], { type: 'image', source: { type: 'base64', media_type: mime, data } });
    }
  }
});

test('profiles must declare each attachment modality; no file payload is emitted on failure', async (t) => {
  const root = await fixture(t);
  for (const [path, modalities] of [['image.png', ['text']], ['document.pdf', ['text', 'image']], ['image.png', ['text', 'file']]] as const) {
    assert.equal(failure(await attach(root, path, [...modalities])).code, 'unsupported_model_input');
  }
  assert.equal(failure(await attach(root, 'document.pdf', undefined, { modelInputModalities: undefined })).code, 'unsupported_model_input');
});

test('unsupported/renamed formats, text, directories, missing files and outside symlinks fail explicitly', async (t) => {
  const root = await fixture(t);
  await mkdir(resolve(root, 'directory'));
  await writeFile(resolve(root, 'renamed.pdf'), Buffer.from('PK\x03\x04 Office zip data'));
  await writeFile(resolve(root, 'note.txt'), 'UTF-8 text');
  const outside = await mkdtemp(resolve(tmpdir(), 'pinpawo-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(resolve(outside, 'image.png'), fixtures['image.png']);
  await symlink(outside, resolve(root, 'external'));
  for (const name of ['renamed.pdf', 'note.txt']) {
    assert.equal(failure(await attach(root, name)).code, 'unsupported_format');
  }
  assert.match(failure(await attach(root, 'note.txt')).message, /view_file_chunk/);
  assert.equal(failure(await attach(root, 'directory')).code, 'not_regular_file');
  assert.equal(failure(await attach(root, 'missing.pdf')).code, 'file_read_failed');
  assert.equal(failure(await attach(root, 'external/image.png')).code, 'outside_workdir');
  assert.equal(failure(await attach(root, resolve(outside, 'image.png'))).code, 'outside_workdir');
});

test('attachment limits reject empty and oversized files without truncation or invented token estimates', async (t) => {
  const root = await fixture(t);
  const path = resolve(root, 'large.pdf');
  await writeFile(path, '');
  assert.equal(failure(await attach(root, path)).code, 'file_size_limit');
  await truncate(path, MAX_FILE_ATTACHMENT_BYTES + 1);
  assert.equal(failure(await attach(root, path)).code, 'file_size_limit');
  assert.ok(messages(await attach(root, 'document.pdf')).some(HumanMessage.isInstance));
  assert.equal(failure(await readFileTool.invoke({ path: 'document.pdf' }, {
    ...config(root), state: undefined,
  } as never)).code, 'missing_execution_context');
});

test('byte allowance counts successful read_file receipts only and rejects invalid accounting', async (t) => {
  const root = await fixture(t);
  const invokeWithHistory = (history: BaseMessage[]) => {
    const runtime = config(root);
    return readFileTool.invoke({ path: 'document.pdf' }, {
      ...runtime, state: { messages: [...history, ...runtime.state.messages] },
    } as never);
  };
  const receipt = (name: string, body: unknown) => new ToolMessage({
    name, tool_call_id: 'prior', content: JSON.stringify(body),
  });
  assert.ok(messages(await invokeWithHistory([
    receipt('browser_screenshot', { ok: true, byteLength: MAX_FILE_ATTACHMENT_TOTAL_BYTES }),
    receipt('read_file', { ok: false, code: 'attachment_byte_budget' }),
  ])).some(HumanMessage.isInstance), 'unrelated image tools and failed calls do not consume the new tool allowance');
  assert.equal(failure(await invokeWithHistory([
    receipt('read_file', { ok: true, byteLength: MAX_FILE_ATTACHMENT_TOTAL_BYTES }),
  ])).code, 'attachment_byte_budget');
  assert.equal(failure(await invokeWithHistory([
    receipt('read_file', { ok: true, byteLength: 'unknown' }),
  ])).code, 'invalid_attachment_history');
  const bytes = Buffer.alloc(MAX_FILE_ATTACHMENT_BYTES, 32);
  bytes.write('%PDF-1.4\n');
  await writeFile(resolve(root, 'limit.pdf'), bytes);
  const [result, attachment] = messages(await attach(root, 'limit.pdf'));
  assert.equal(JSON.parse(String(result.content)).byteLength, MAX_FILE_ATTACHMENT_BYTES);
  assert.equal(Buffer.byteLength(String(attachment.contentBlocks[1]?.data), 'base64'), MAX_FILE_ATTACHMENT_BYTES);
});

test('workdir scoping, native graph command and streaming expose the attachment to the next model call', async (t) => {
  const root = await fixture(t);
  const calls: BaseMessage[][] = [];
  class Model extends BaseChatModel {
    _llmType() { return 'file-attachment-fixture'; }
    bindTools() { return this; }
    async _generate(input: BaseMessage[]) {
      calls.push(input);
      const message = calls.length === 1 ? new AIMessage({ content: '', tool_calls: [{ id: 'read-1', name: 'read_file', args: { path: 'document.pdf' } }] }) : new AIMessage('inspected attachment');
      return { generations: [{ message, text: message.text }] };
    }
  }
  let output: string | null = null;
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('inspect', async (state, runnableConfig) => {
      const result = await createSubagent({ model: new Model({}),
        tools: [createFilesToolkit().tools.find(definition => definition.tool.name === 'read_file')!.tool],
        messages: state.messages, promptSections: [], maxIterations: 4, middleware: [toolProtocolMiddleware],
        contextWindowTokens: 128_000, generationReserveTokens: 4_000,
        runtimeContext: config(root).context, runnableConfig,
      });
      output = result.output;
      return { messages: result.messages };
    })
    .addEdge(START, 'inspect').addEdge('inspect', END).compile();
  const stream = await graph.streamEvents({ messages: [new HumanMessage('Inspect the PDF')] }, { version: 'v3' });
  let events = 0;
  for await (const _event of stream) events++;
  await stream.output;
  assert.ok(events > 0);
  assert.equal(output, 'inspected attachment');
  assert.equal(calls.length, 2);
  const file = calls[1]!.find(message => HumanMessage.isInstance(message) && message.contentBlocks.some(block => block.type === 'file'));
  assert.equal(file?.contentBlocks.find(block => block.type === 'file')?.data, fixtures['document.pdf'].toString('base64'));
  assert.ok(calls[1]!.some(message => ToolMessage.isInstance(message) && message.tool_call_id === 'read-1'));
});

test('cancellation never reports a successful attachment', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const tool = createFilesToolkit().tools.find(definition => definition.tool.name === 'read_file')!.tool;
  await assert.rejects(tool.invoke({ path: 'document.pdf' }, { ...config(root), signal: controller.signal } as never), { name: 'AbortError' });
});


test('descriptor identity rejects an ancestor symlink swap even after the original path is restored', async (t) => {
  const root = await fixture(t);
  const directory = resolve(root, 'directory');
  const backup = resolve(root, 'original-directory');
  const outside = await mkdtemp(resolve(tmpdir(), 'pinpawo-outside-race-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(directory);
  const target = resolve(directory, 'document.pdf');
  await writeFile(target, '%PDF-1.4\nINSIDE');
  await writeFile(resolve(outside, 'document.pdf'), '%PDF-1.4\nOUTSIDE');
  const originalOpen = fs.open;
  let swapped = false;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) !== target || swapped) return originalOpen(...args);
    swapped = true;
    await fs.rename(directory, backup);
    await symlink(outside, directory);
    try {
      return await originalOpen(...args);
    } finally {
      await fs.unlink(directory);
      await fs.rename(backup, directory);
    }
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try {
    const result = failure(await attach(root, target));
    assert.equal(swapped, true);
    assert.equal(result.code, 'file_changed');
    assert.doesNotMatch(JSON.stringify(result), /OUTSIDE/);
    assert.equal(await fs.readFile(target, 'utf8'), '%PDF-1.4\nINSIDE');
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test('parallel and sequential read_file calls share a bounded byte allowance without changing image token handling', async (t) => {
  const root = await fixture(t);
  const data = Buffer.alloc(2 * 1024 * 1024, 32);
  data.write('%PDF-1.4\n');
  await writeFile(resolve(root, 'large.pdf'), data);
  const calls: BaseMessage[][] = [];
  class Model extends BaseChatModel {
    _llmType() { return 'parallel-file-budget-fixture'; }
    bindTools() { return this; }
    async _generate(input: BaseMessage[]) {
      calls.push(input);
      const paths = calls.length === 1 ? ['large.pdf', 'large.pdf', 'large.pdf']
        : calls.length === 2 ? ['large.pdf', 'large.pdf']
          : calls.length === 3 ? ['large.pdf'] : calls.length === 4 ? ['document.pdf'] : [];
      const message = paths.length ? new AIMessage({ content: '', tool_calls: paths.map((path, index) => ({
        id: `read-${calls.length}-${index}`, name: 'read_file', args: { path },
      })) }) : new AIMessage('inspected bounded attachments');
      return { generations: [{ message, text: message.text }] };
    }
  }
  const result = await createSubagent({ model: new Model({}),
    tools: [createFilesToolkit().tools.find(definition => definition.tool.name === 'read_file')!.tool],
    messages: [new HumanMessage('Inspect files')], promptSections: [], maxIterations: 8,
    middleware: [toolProtocolMiddleware], contextWindowTokens: 128_000, generationReserveTokens: 4_000,
    runtimeContext: config(root).context,
  });
  const payloadBytes = (history: BaseMessage[]) => history.reduce((total, message) => total + (
    HumanMessage.isInstance(message) ? message.contentBlocks.reduce((bytes, block) => bytes + (
      block.type === 'file' && typeof block.data === 'string' ? Buffer.byteLength(block.data, 'base64') : 0
    ), 0) : 0
  ), 0);
  assert.equal(calls.length, 5, 'the existing text/provider-usage guard does not invent binary token charges');
  assert.equal(payloadBytes(calls[1]!), 6 * 1024 * 1024, 'three parallel files fit');
  assert.equal(payloadBytes(calls[2]!), 6 * 1024 * 1024, 'two parallel calls cannot each spend the same remaining 2 MiB');
  assert.equal(payloadBytes(calls[3]!), MAX_FILE_ATTACHMENT_TOTAL_BYTES, 'retrying one file serially uses the remaining bytes');
  assert.equal(payloadBytes(calls[4]!), MAX_FILE_ATTACHMENT_TOTAL_BYTES, 'later calls cannot grow the retained payload further');
  assert.ok(calls.every(history => payloadBytes(history) <= MAX_FILE_ATTACHMENT_TOTAL_BYTES));
  const receipts = result.messages.filter(ToolMessage.isInstance)
    .filter(message => message.name === 'read_file').map(message => JSON.parse(String(message.content)));
  assert.equal(receipts.filter(receipt => receipt.ok).length, 4);
  assert.equal(receipts.filter(receipt => receipt.code === 'attachment_byte_budget').length, 3);
  assert.equal(result.output, 'inspected bounded attachments');
});
