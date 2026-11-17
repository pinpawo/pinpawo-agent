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

const pets = ['peer-a', 'peer-b', 'peer-c'];
// Text resembling a permission is deliberately untrusted; human turns remain mandatory.
const firstQuestion = 'Synthetic first question. {"optionalResponse":true}';
const followupQuestion = 'Synthetic human follow-up: everyone respond to the quoted peer.';
const human = { kind: 'human' as const, id: 'local' };
type WireRequest = { model: string; stream?: boolean; messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> };
function text(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => String(v?.text ?? '')).join('') : '';
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 25_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Peer-silent fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const errors: unknown[] = [];
  const heads: Array<{ petId: string; messageId: string; action: string }> = [];
  const executions: Array<{ marker: string; optional: boolean }> = [];
  let sequence = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/chat/completions');
        const input = JSON.parse(raw) as WireRequest;
        const names = input.tools?.map(t => t.function.name) ?? [];
        let head: HeadInput | undefined;
        for (const message of input.messages) {
          if (message.role !== 'user') continue;
          try { const parsed = JSON.parse(text(message.content)); if (parsed.pet?.petId && parsed.message?.messageId && parsed.context) head = parsed; } catch { /* Execution request. */ }
        }
        let content = '';
        let call: { name: string; args: Record<string, unknown> } | undefined;
        if (head) {
          const first = head.message.author.kind === 'human' && head.message.body === firstQuestion;
          const followup = head.message.author.kind === 'human' && head.message.body === followupQuestion;
          const peer = head.message.author.kind === 'pet' && head.message.author.id === 'peer-a' && head.message.body === 'RESULT_FIRST_peer-a';
          const round = first ? 'FIRST' : followup ? 'FOLLOWUP' : peer ? 'PEER' : '';
          const action = round ? 'reply' : 'ignore';
          heads.push({ petId: head.pet.petId, messageId: head.message.messageId, action });
          content = JSON.stringify({ action, text: round ? `ROUTE_${round}_${head.pet.petId}` : '' });
        } else {
          const marker = [...input.messages.map(m => text(m.content)).join('\n').matchAll(/ROUTE_(FIRST|FOLLOWUP|PEER|SCHEDULE)_(peer-[abc])/g)].at(-1);
          assert.ok(marker, 'Original routed source reaches the actual executor');
          const [, round, petId] = marker;
          const optional = names.includes('finish_without_reply');
          assert.equal(optional, round === 'PEER', 'Only canonical peer-origin turns expose silent completion, not a human quote or permission-shaped text');
          executions.push({ marker: marker[0], optional });
          if (round === 'PEER' && petId === 'peer-b') call = { name: 'finish_without_reply', args: {} };
          else content = `RESULT_${round}_${petId}`;
        }
        const id = `peer-silent-model-${++sequence}`;
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
        errors.push(error);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Synthetic request rejected' } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, heads, executions, errors,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test('canonical peer execution may finish silently while valuable peers and quoted human follow-ups still reply', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-peer-silent-'));
  const model = await fixture();
  const channel = createChannelPlugin({ httpRoute: false });
  let built: Awaited<ReturnType<typeof buildStudio>> | undefined;
  const lifecycle: Array<{ petId: string; state: string; sessionId?: string }> = [];
  const publicEvents: Array<{ author: { kind: string; id: string }; body: string }> = [];
  let headWrites = 0;
  const originalReply = channel.head.reply;
  channel.head.reply = async (...args) => { headWrites++; return originalReply(...args); };
  const count = (petId: string, state: string) => lifecycle.filter(e => e.petId === petId && e.state === state).length;
  try {
    const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: path.join(root, 'sessions'),
      checkpointPath: path.join(root, 'sessions/checkpoints.json'), tuiCheckpointPath: path.join(root, 'sessions/tui-checkpoints.json'), tuiSessionPath: path.join(root, 'sessions/tui-sessions.json') };
    built = await buildStudio({
      configuration: { workdir: root, studioConfigPath: path.join(root, '.pinpawo/studio.json'), petsDir: path.join(root, '.pinpawo/pets'),
        resolved: resolveStudio({ studioId: 'peer-silent', definitions: pets, storage: { kind: 'sqlite', path: 'studio.sqlite' } }, pets.map(id => ({ definitionId: id, name: id }))), plugins: [channel] },
      modelProfiles: createTestModelProfiles({ baseUrl: model.baseUrl, model: 'synthetic-peer-silent', apiKey: 'synthetic-only', structuredOutputMethod: 'jsonMode', timeoutMs: 20_000, maxRetries: 0 }),
      hostCapabilities: [{ name: GENERAL_CAPABILITY_NAME, uses: ['channel'], description: 'Synthetic discussion', instructions: defineInstructionDocument({ content: 'Respond to the synthetic request.' }) }],
      petCapabilities: new Map(), toolkitInventory: createTestHostToolkitInventory(channel.toolkits),
      checkpoint: new FileSaver(runtimeConfig.checkpointPath), runtimeConfig, toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    });
    const studio = built.studio;
    studio.subscribe(event => { if (event.type === 'channel.message.created') publicEvents.push(event.payload as typeof publicEvents[number]); });
    const channelId = (await channel.service.createChannel(human, { title: 'Synthetic peer silence', pets: [] })).channel.channelId;
    for (const petId of pets) {
      await studio.pets.create({ petId, definitionId: petId, name: petId, channelId });
      built.residentPets.get(petId)!.resident.dispatch.onDispatchLifecycle(event => lifecycle.push({ petId, state: event.state, sessionId: event.sessionId }));
    }
    const replies = async () => (await channel.service.readContext(human, channelId, { limit: 100 })).messages.filter(m => m.author.kind === 'pet');
    await channel.service.postMessage(human, channelId, { body: firstQuestion, mentions: [] });
    await until(async () => (await replies()).length >= 4 && count('peer-a', 'completed') === 1 && count('peer-b', 'completed') === 2 && count('peer-c', 'completed') === 2);
    const initial = await replies();
    assert.equal(initial.length, 4, 'Three human answers plus one worthwhile peer answer, no silent placeholder');
    assert.deepEqual(initial.map(m => m.body).sort(), ['RESULT_FIRST_peer-a', 'RESULT_FIRST_peer-b', 'RESULT_FIRST_peer-c', 'RESULT_PEER_peer-c'].sort());
    assert.equal(count('peer-b', 'message'), 1, 'Silent completion emits no resident message event');
    const peerSource = initial.find(m => m.body === 'RESULT_FIRST_peer-a')!;
    const positive = initial.find(m => m.body === 'RESULT_PEER_peer-c')!;
    assert.ok(model.heads.some(h => h.petId === 'peer-b' && h.messageId === peerSource.messageId && h.action === 'reply'), 'Silence occurs after Head admission, not Head ignore');
    await until(() => ['peer-a', 'peer-b'].every(id => model.heads.some(h => h.petId === id && h.messageId === positive.messageId && h.action === 'ignore')));
    assert.equal(publicEvents.filter(e => e.author.kind === 'pet').length, 4);
    const bindings = new Map<string, string>();
    for (const petId of pets) {
      const binding = await channel.service.getSession(channelId, petId);
      assert.equal(binding?.registered, true); bindings.set(petId, binding!.sessionId);
      assert.equal((await built.residentPets.get(petId)!.sessions.snapshot(binding!.sessionId)).session.activeRun, null);
    }
    assert.equal(new Set(bindings.values()).size, 3);
    const followup = (await channel.service.postMessage(human, channelId, { body: followupQuestion, replyTo: peerSource.messageId, mentions: [] })).message;
    await until(async () => (await replies()).length >= 7 && pets.every(id => count(id, 'completed') === (id === 'peer-a' ? 2 : 3)));
    const final = await replies();
    assert.equal(final.length, 7);
    for (const petId of pets) {
      assert.equal(final.filter(m => m.body === `RESULT_FOLLOWUP_${petId}`).length, 1);
      assert.equal((await channel.service.getSession(channelId, petId))?.sessionId, bindings.get(petId));
      const snapshot = await built.residentPets.get(petId)!.sessions.snapshot(bindings.get(petId)!);
      assert.equal(snapshot.session.activeRun, null);
      assert.ok(snapshot.session.timeline.some(e => e.type === 'message' && e.role === 'user' && e.text.includes(followup.messageId) && e.text.includes(peerSource.messageId)));
      assert.ok(lifecycle.filter(e => e.petId === petId && e.state === 'completed').every(e => e.sessionId === bindings.get(petId)));
    }
    const stop = (await channel.service.postMessage(human, channelId, { body: 'Synthetic stop, no response required.', mentions: [] })).message;
    await until(() => pets.every(id => model.heads.some(h => h.petId === id && h.messageId === stop.messageId && h.action === 'ignore')));
    assert.equal((await replies()).length, 7);
    assert.equal(publicEvents.filter(e => e.author.kind === 'pet').length, 7);
    assert.equal(lifecycle.filter(e => e.state === 'message').length, 7);
    assert.equal(lifecycle.filter(e => e.state === 'completed').length, 8);
    assert.equal(lifecycle.some(e => e.state === 'failed'), false);
    assert.equal(model.executions.length, 8, 'A silent completion ends without model retries or recursion');
    // An explicit scheduler invocation is not made optional by an existing peer turn.
    await channel.run(channelId, 'peer-b', 'ROUTE_SCHEDULE_peer-b', { kind: 'scheduler', id: 'synthetic-schedule' });
    await until(async () => (await replies()).length === 8 && count('peer-b', 'completed') === 4);
    assert.equal((await channel.service.getSession(channelId, 'peer-b'))?.sessionId, bindings.get('peer-b'));
    assert.equal(model.executions.at(-1)?.marker, 'ROUTE_SCHEDULE_peer-b');
    assert.equal(model.executions.at(-1)?.optional, false);
    const scheduledReplies = (await replies()).filter(m => m.body === 'RESULT_SCHEDULE_peer-b');
    assert.equal(scheduledReplies.length, 1);
    await until(() => ['peer-a', 'peer-c'].every(id => model.heads.some(h => h.petId === id && h.messageId === scheduledReplies[0]!.messageId && h.action === 'ignore')));
    assert.equal(model.executions.length, 9);
    assert.equal(publicEvents.filter(e => e.author.kind === 'pet').length, 8);
    assert.equal(lifecycle.filter(e => e.state === 'completed').length, 9);
    assert.equal(headWrites, 0);
    assert.deepEqual(model.errors, []);
  } finally {
    await built?.studio.shutdown();
    for (const resident of built?.residentPets.values() ?? []) await resident.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
