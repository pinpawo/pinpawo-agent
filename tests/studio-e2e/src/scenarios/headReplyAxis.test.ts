import './isolateScenarioConfig';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineInstructionDocument, GENERAL_CAPABILITY_NAME } from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver } from 'pinpawo/host-runtime';
import { buildStudio } from '../../../../packages/studio/src/host/buildStudio';
import { resolveStudio } from '../../../../packages/studio/src/host/studioConfig';
import type { HeadInput } from '../../../../packages/studio/src/host/petHead';
import { createChannelPlugin } from '../../../../plugins/channel/src/channelPlugin';
import { createTestModelProfiles } from '../../../../services/host/src/testing/modelProfiles';
import { createTestHostToolkitInventory } from '../../../../services/host/src/testing/toolkitInventory';


const human = { kind: 'human' as const, id: 'local' };
type WireRequest = { model: string; stream?: boolean; messages: Array<{ role: string; content?: unknown }> };
function text(value: unknown): string { return typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => String(v?.text ?? '')).join('') : ''; }
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Head reply-axis fixture timed out'); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture() {
  const errors: unknown[] = [];
  const decisions: Array<{ petId: string; channelId: string; messageId: string }> = [];
  let sequence = 0, executions = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      try {
        const input = JSON.parse(raw) as WireRequest;
        let head: HeadInput | undefined;
        for (const m of input.messages) {
          if (m.role !== 'user') continue;
          try { const value = JSON.parse(text(m.content)); if (value.pet?.petId && value.message?.messageId && value.context) head = value; } catch { /* Executor. */ }
        }
        let content = '';
        let call: { name: string; args: Record<string, unknown> } | undefined;
        if (head) {
          decisions.push({ petId: head.pet.petId, channelId: head.message.channelId, messageId: head.message.messageId });
          const source = head.pet.petId === 'target' && head.message.author.kind === 'human' ? head.message.body : '';
          const dispatch = source === 'DISPATCH' || source === 'COMBINED';
          const reply = source === 'DIRECT' || source === 'COMBINED' ? `HEAD_${source}` : '';
          content = JSON.stringify({ action: dispatch ? 'dispatch' : 'ignore', reply, intent: dispatch ? `ROUTE_${source}` : '', timing: 'enqueue' });
        } else {
          executions++;
          const marker = [...input.messages.map(m => text(m.content)).join('\n').matchAll(/ROUTE_(DISPATCH|COMBINED)/g)].at(-1)?.[1];
          assert.ok(marker);
          content = `FINAL_${marker}`;
        }
        const id = `reply-axis-model-${++sequence}`;
        const message = { role: 'assistant', content, ...(call ? { tool_calls: [{ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) };
        const finish = call ? 'tool_calls' : 'stop';
        if (input.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = { ...message, ...(call ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : {}) };
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      } catch (error) {
        errors.push(error); response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Synthetic reply-axis request rejected' } }));
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, decisions, errors, executionCount: () => executions,
    close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }) };
}

test('Head reply and dispatch are independent: four combinations, stable execution session, no cross-channel or acknowledgement chain', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-head-reply-axis-'));
  const model = await fixture();
  const channel = createChannelPlugin({ httpRoute: false });
  let built: Awaited<ReturnType<typeof buildStudio>> | undefined;
  const lifecycle: Array<{ state: string; sessionId?: string }> = [];
  try {
    const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: path.join(root, 'sessions'), checkpointPath: path.join(root, 'sessions/checkpoints.json'),
      tuiCheckpointPath: path.join(root, 'sessions/tui-checkpoints.json'), tuiSessionPath: path.join(root, 'sessions/tui-sessions.json') };
    const pets = ['target', 'observer', 'foreign'];
    built = await buildStudio({ configuration: { workdir: root, studioConfigPath: path.join(root, '.pinpawo/studio.json'), petsDir: path.join(root, '.pinpawo/pets'),
      resolved: resolveStudio({ studioId: 'reply-axis', definitions: pets, storage: { kind: 'sqlite', path: 'studio.sqlite' } }, pets.map(id => ({ definitionId: id, name: id }))), plugins: [channel] },
      modelProfiles: createTestModelProfiles({ baseUrl: model.baseUrl, model: 'synthetic-reply-axis', apiKey: 'synthetic-only', structuredOutputMethod: 'jsonMode', timeoutMs: 20_000, maxRetries: 0 }),
      hostCapabilities: [{ name: GENERAL_CAPABILITY_NAME, uses: ['channel'], description: 'Synthetic response', instructions: defineInstructionDocument({ content: 'Answer the synthetic request.' }) }],
      petCapabilities: new Map(), toolkitInventory: createTestHostToolkitInventory(channel.toolkits), checkpoint: new FileSaver(runtimeConfig.checkpointPath), runtimeConfig,
      toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    });
    const studio = built.studio;
    const ownerId = (await channel.service.createChannel(human, { title: 'Four Head combinations', pets: [] })).channel.channelId;
    const foreignId = (await channel.service.createChannel(human, { title: 'Unrelated Channel', pets: [] })).channel.channelId;
    for (const petId of pets) await studio.pets.create({ petId, definitionId: petId, name: petId, channelId: petId === 'foreign' ? foreignId : ownerId });
    built.residentPets.get('target')!.resident.dispatch.onDispatchLifecycle(e => lifecycle.push({ state: e.state, sessionId: e.sessionId }));
    const replies = async () => (await channel.service.readContext(human, ownerId, { limit: 100 })).messages.filter(m => m.author.kind === 'pet');
    const post = async (body: string) => (await channel.service.postMessage(human, ownerId, { body, mentions: [] })).message;
    const direct = await post('DIRECT');
    await until(async () => (await replies()).length === 1);
    const directReply = (await replies())[0]!;
    assert.equal(directReply.body, 'HEAD_DIRECT');
    assert.equal(directReply.author.id, 'target');
    assert.equal(directReply.replyTo, direct.messageId);
    assert.equal(await channel.service.getSession(ownerId, 'target'), undefined, 'Direct-only response must not reserve an execution session');
    assert.equal(model.executionCount(), 0);
    studio.notify({ type: 'channel.message.created', source: 'channel', topic: ownerId, occurredAt: new Date().toISOString(), payload: direct });
    await until(() => model.decisions.filter(d => d.petId === 'target' && d.messageId === direct.messageId).length === 2);
    const empty = await post('EMPTY');
    await until(() => ['target', 'observer'].every(id => model.decisions.some(d => d.petId === id && d.messageId === empty.messageId)));
    assert.equal((await replies()).length, 1);
    assert.equal(await channel.service.getSession(ownerId, 'target'), undefined);
    await post('DISPATCH');
    await until(async () => (await replies()).length === 2 && lifecycle.filter(e => e.state === 'completed').length === 1);
    assert.equal((await replies())[1]!.body, 'FINAL_DISPATCH');
    const binding = await channel.service.getSession(ownerId, 'target');
    assert.equal(binding?.registered, true);
    const combined = await post('COMBINED');
    await until(async () => (await replies()).length === 4 && lifecycle.filter(e => e.state === 'completed').length === 2);
    const all = await replies();
    assert.deepEqual(all.map(m => m.body), ['HEAD_DIRECT', 'FINAL_DISPATCH', 'HEAD_COMBINED', 'FINAL_COMBINED']);
    assert.equal(all[2]!.replyTo, combined.messageId);
    assert.ok(all[1]!.externalRef && all[3]!.externalRef);
    assert.equal((await channel.service.getSession(ownerId, 'target'))?.sessionId, binding!.sessionId);
    assert.ok(lifecycle.filter(e => e.state === 'completed').every(e => e.sessionId === binding!.sessionId));
    assert.equal((await built.residentPets.get('target')!.sessions.snapshot(binding!.sessionId)).session.activeRun, null);
    studio.notify({ type: 'channel.message.created', source: 'channel', topic: ownerId, occurredAt: new Date().toISOString(), payload: combined });
    await until(() => model.decisions.filter(d => d.petId === 'target' && d.messageId === combined.messageId).length === 2);
    const stop = await post('EMPTY');
    await until(() => ['target', 'observer'].every(id => model.decisions.some(d => d.petId === id && d.messageId === stop.messageId)));
    assert.equal((await replies()).length, 4, 'Head acknowledgements do not initiate a recursive fixture exchange');
    assert.equal(model.executionCount(), 2);
    assert.equal(await channel.service.getSession(ownerId, 'observer'), undefined);
    assert.equal(await channel.service.getSession(foreignId, 'foreign'), undefined);
    assert.equal(model.decisions.some(d => d.petId === 'foreign'), false, 'Other-channel Head never sees these messages');
    assert.equal(lifecycle.some(e => e.state === 'failed'), false);
    assert.deepEqual(model.errors, []);
  } finally {
    await built?.studio.shutdown();
    for (const resident of built?.residentPets.values() ?? []) await resident.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
