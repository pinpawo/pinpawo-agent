import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import { createSubagent } from '@pinpawo/pet-agent';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import {
  createArtifactsToolkit,
  limitArtifactBody,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from './index';

function body(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  } });
}

async function readBody(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const ref: ArtifactRef = {
  uri: 'artifact://workspace/first/report.txt', name: 'report.txt',
  mimeType: 'text/plain', size: 8, sha256: 'hash', createdAt: '2026-11-05T00:00:00.000Z',
};

function fixture() {
  const snapshots = new Map<string, { ref: ArtifactRef; text: string; threadId: string }>();
  const reads: Array<{ path: string; workdir: string | null }> = [];
  const writes: Array<{ path?: string; threadId: string; workdir: string | null; text: string }> = [];
  let source = 'snapshot';
  const store: ArtifactStore = {
    async put(input) {
      const published = { ...ref, name: input.name,
        uri: `${ref.uri.slice(0, ref.uri.lastIndexOf('/') + 1)}${input.name}`,
        ...(input.title !== undefined ? { title: input.title } : {}) };
      snapshots.set(published.uri, { ref: published, text: await readBody(input.body), threadId: input.threadId });
      return published;
    },
    async list(threadId) {
      return [...snapshots.values()].filter((item) => item.threadId === threadId).map((item) => item.ref);
    },
    async fetch(uri) {
      const item = snapshots.get(uri);
      if (!item) throw new Error('Not found');
      return { ref: item.ref, body: body(item.text) };
    },
  };
  const toolkit = createArtifactsToolkit({
    store,
    sourceReader: async (input) => {
      reads.push(input);
      return { name: input.path.split('/').at(-1)!, mimeType: 'text/plain', body: body(source) };
    },
    downloadWriter: async (input) => {
      writes.push({ ...input, text: await readBody(input.body) });
      return input.path ?? `/tmp/${input.threadId}/report.txt`;
    },
  });
  const definition = (name: string) => toolkit.tools.find((item) => item.tool.name === name)!;
  const config = (threadId = 'first') => ({ context: { executionScope: {
    threadId, workdir: '/work', taskId: 'task', runId: 'run', delegationId: 'delegation',
  } } });
  const publish = (path = 'report.txt', title?: string) => definition('publish_artifact').tool.invoke({
    name: 'publish_artifact', id: `publish:${path}`, type: 'tool_call',
    args: { path, ...(title !== undefined ? { title } : {}) },
  }, config());
  return { store, toolkit, definition, config, publish, snapshots, reads, writes, setSource: (text: string) => { source = text; } };
}

test('publishing snapshots a local file, records its successful receipt, and lists the execution session', async () => {
  const f = fixture();
  const result = await f.publish('report.txt', 'Report');
  assert.ok(result instanceof Command);
  const update = result.update as { deliverables: unknown; messages: ToolMessage[] };
  assert.deepEqual(update.deliverables, [{ uri: ref.uri, title: 'Report' }]);
  assert.deepEqual(update.messages[0].artifact, { ...ref, title: 'Report' });
  assert.equal(update.messages[0].tool_call_id, 'publish:report.txt');
  assert.ok(String(update.messages[0].content).includes(`[Report](${ref.uri})`));
  assert.deepEqual(f.reads, [{ path: 'report.txt', workdir: '/work' }]);
  f.setSource('changed after publication');
  assert.equal(f.snapshots.get(ref.uri)?.text, 'snapshot');
  const list = f.definition('list_artifacts').tool;
  assert.deepEqual(JSON.parse(String(await list.invoke({}, f.config()))), [{ ...ref, title: 'Report' }]);
  assert.deepEqual(JSON.parse(String(await list.invoke({}, f.config('second')))), []);
});

test('download accepts a shared reference and does not declare a second deliverable', async () => {
  const f = fixture();
  await f.publish();
  const result = await f.definition('download_artifact').tool.invoke({
    name: 'download_artifact', id: 'download', type: 'tool_call', args: { uri: ref.uri },
  }, f.config('second'));
  assert.ok(ToolMessage.isInstance(result));
  assert.equal(result.artifact, undefined);
  assert.deepEqual(JSON.parse(String(result.content)), { path: '/tmp/second/report.txt', ref });
  assert.deepEqual(f.writes.map(({ path, threadId, workdir, text }) => ({ path, threadId, workdir, text })), [
    { path: undefined, threadId: 'second', workdir: '/work', text: 'snapshot' },
  ]);
});

test('default, workdir and temporary download destinations need no review and retain execution paths', async () => {
  const f = fixture();
  const definition = f.definition('download_artifact');
  const context = { toolkitName: 'artifacts', toolName: 'download_artifact',
    reviewCapabilities: { humanReview: true, sessionAuthorization: true } };
  await f.publish();
  for (const path of [undefined, 'report.txt', '/work/report.txt', '/tmp/report.txt']) {
    const input = { uri: ref.uri, ...(path !== undefined ? { path } : {}) };
    assert.equal(await definition.review?.request({ ...context, input }), null);
    const result = await definition.tool.invoke(input, f.config('second'));
    assert.equal(JSON.parse(String(result)).path, path ?? '/tmp/second/report.txt');
  }
  assert.equal(definition.review?.authorization, undefined);
  assert.deepEqual(f.writes.map(({ path, workdir }) => ({ path, workdir })), [
    { path: undefined, workdir: '/work' },
    { path: 'report.txt', workdir: '/work' },
    { path: '/work/report.txt', workdir: '/work' },
    { path: '/tmp/report.txt', workdir: '/work' },
  ]);
});

class ScriptedModel extends FakeToolCallingModel {
  private execution = { summaries: 0, normalCalls: 0 };
  private toolsBound = false;

  get summaries() { return this.execution.summaries; }

  override bindTools() {
    const bound = new ScriptedModel({ toolCalls: this.toolCalls });
    bound.execution = this.execution;
    bound.toolsBound = true;
    return bound;
  }

  override async _generate() {
    const summarizing = !this.toolsBound;
    if (summarizing) this.execution.summaries += 1;
    const calls = summarizing ? [] : this.toolCalls[this.execution.normalCalls++] ?? [];
    const text = summarizing ? 'Earlier execution details summarized.' : calls.length ? '' : 'Done.';
    return { generations: [{ text, message: new AIMessage({ content: text, tool_calls: calls }) }], llmOutput: {} };
  }
}

test('execution state accumulates parallel publications by URI while list and download leave it unchanged', async () => {
  const f = fixture();
  const model = new ScriptedModel({ toolCalls: [
    [
      { id: 'first', name: 'publish_artifact', args: { path: 'report.txt', title: 'Report' } },
      { id: 'second', name: 'publish_artifact', args: { path: 'data.csv' } },
      { id: 'repeat', name: 'publish_artifact', args: { path: 'report.txt', title: 'Duplicate' } },
    ],
    [
      { id: 'list', name: 'list_artifacts', args: {} },
      { id: 'download', name: 'download_artifact', args: { uri: ref.uri } },
    ],
    [],
  ] });
  const result = await createSubagent({
    model, tools: f.toolkit.tools.map(({ tool }) => tool), stateSchema: f.toolkit.stateSchema,
    promptSections: [], messages: [new HumanMessage('Deliver the report and data.')],
    runtimeContext: f.config().context,
  });
  assert.deepEqual(result.state.deliverables, [
    { uri: ref.uri, title: 'Report' },
    { uri: 'artifact://workspace/first/data.csv' },
  ]);
  assert.equal(result.messages.filter(message => ToolMessage.isInstance(message)
    && message.name === 'publish_artifact').length, 3);
  const next = await createSubagent({
    model: new ScriptedModel(), tools: f.toolkit.tools.map(({ tool }) => tool), stateSchema: f.toolkit.stateSchema,
    promptSections: [], messages: [new HumanMessage('Start a separate execution.')],
    runtimeContext: f.config().context,
  });
  assert.deepEqual(next.state.deliverables, []);
});

test('a failed publication returns no successful state update', async () => {
  const f = fixture();
  f.store.put = async () => { throw new Error('Publication failed.'); };
  await assert.rejects(f.publish(), /Publication failed/);
  assert.equal(f.snapshots.size, 0);
});

test('native context compaction can remove publication messages while accumulated references remain', async () => {
  const f = fixture();
  const addContext = tool((_input, runtime) => new Command({ update: {
    messages: [
      new ToolMessage({ name: 'add_context', tool_call_id: runtime.toolCall!.id!, content: 'Investigation recorded.' }),
      new HumanMessage(`other investigation\n${'x'.repeat(1600)}`),
      new AIMessage(`other findings\n${'y'.repeat(1600)}`),
      new HumanMessage(`verification\n${'z'.repeat(1600)}`),
      new AIMessage(`verification findings\n${'w'.repeat(1600)}`),
      new HumanMessage('Finish the delegated task.'),
    ],
  } }), { name: 'add_context', description: 'Record investigation context.', schema: z.object({}) });
  const model = new ScriptedModel({ toolCalls: [
    [{ id: 'published-before-context', name: 'publish_artifact', args: { path: 'report.txt' } }],
    [{ id: 'context', name: 'add_context', args: {} }],
    [],
  ] });
  const result = await createSubagent({
    model, tools: [...f.toolkit.tools.map(({ tool }) => tool), addContext], stateSchema: f.toolkit.stateSchema,
    promptSections: [], messages: [new HumanMessage('Publish the report and verify the result.')],
    runtimeContext: f.config().context, contextWindowTokens: 1000, maxIterations: 4,
  });
  assert.ok(model.summaries > 0);
  assert.ok(result.messages.some(message => message.additional_kwargs?.lc_source === 'summarization'));
  assert.equal(result.messages.some(message => ToolMessage.isInstance(message)
    && message.tool_call_id === 'published-before-context'), false);
  assert.deepEqual(result.state.deliverables, [{ uri: ref.uri }]);
  assert.equal(result.output, 'Done.');
});

test('a missing execution session, URL source, or malformed reference cannot reach storage', async () => {
  const f = fixture();
  await assert.rejects(f.definition('publish_artifact').tool.invoke({ path: 'report.txt' }), /requires? an Agent session/);
  await assert.rejects(f.definition('publish_artifact').tool.invoke({ path: 'https://example.com/report.txt' }, f.config()));
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.definition('download_artifact').tool.invoke({ uri: 'artifact://../secret' }, f.config()));
  assert.equal(f.writes.length, 0);
});

test('the publication limit rejects overflow and cancels the input rather than truncating it', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const reader = limitArtifactBody(source).getReader();
  let accepted = 0;
  await assert.rejects(async () => {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      accepted += item.value.byteLength;
    }
  }, /100 MB/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, MAX_ARTIFACT_BYTES);
  assert.ok(pulled <= 102);
  assert.equal(cancelled, true);
});

test('a temporary signed URL is consumed for download and is not returned to the agent', async () => {
  const f = fixture();
  f.store.fetch = async () => ({ ref, url: 'data:text/plain,snapshot', expiresAt: '2026-11-05T00:05:00.000Z' });
  const output = await f.definition('download_artifact').tool.invoke({ uri: ref.uri }, f.config());
  assert.equal(f.writes[0]?.text, 'snapshot');
  assert.equal(String(output).includes('data:text/plain'), false);
  assert.deepEqual(JSON.parse(String(output)).ref, ref);
});

test('aborting a bounded stream cancels its source', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const reader = limitArtifactBody(source, abort.signal).getReader();
  const pending = reader.read();
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
