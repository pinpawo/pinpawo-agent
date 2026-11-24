import { headFixtureStage } from './headFixtureStage';
import { readChannelEnvelope } from './channelWire';
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
const queuedRequest = '[@target](participant:pet:target) Run the independent synthetic follow-up.';
type WireMessage = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type WireRequest = { model: string; stream?: boolean; response_format?: { type: string }; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };
function text(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => String(v?.text ?? '')).join('') : '';
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 25_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Queued peer scenario timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const errors: unknown[] = [];
  const heads: Array<{ petId: string; messageId: string; action: string; stage: ReturnType<typeof headFixtureStage>; addressed?: boolean }> = [];
  const runningDecisions: string[] = [];
  let sequence = 0, held = false, aborted = false, released = false, queuedExecutions = 0, parentResumes = 0;
  let release = () => {};
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/chat/completions');
        const input = JSON.parse(raw) as WireRequest;
        const names = input.tools?.map(t => t.function.name) ?? [];
        let head: (HeadInput & { execution?: { status: string; source?: { body: string } } }) | undefined;
        for (const message of input.messages) {
          if (message.role !== 'user') continue;
          try {
            const value = JSON.parse(text(message.content));
            if (value.pet?.petId && value.message?.messageId && value.context) head = value;
          } catch { /* Executor. */ }
        }
        let content = '';
        let call: { name: string; args: Record<string, unknown> } | undefined;
        let hold = false;
        if (head) {
          assert.deepEqual(names, [], 'JSON-mode Head never exposes execution tools');
          assert.deepEqual(input.response_format, { type: 'json_object' });
          const { petId } = head.pet;
          const source = head.message.body;
          const route = petId === 'origin' && source === 'EMIT_ACTIVE_PEER' ? 'SEED_ACTIVE'
            : petId === 'origin' && source === 'EMIT_QUEUED_PEER' ? 'SEED_QUEUED'
            : petId === 'target' && (source === 'ACTIVE_HUMAN' || source === 'ACTIVE_PEER') ? 'ACTIVE'
            : petId === 'target' && source === queuedRequest ? 'QUEUED' : '';
          const stage = headFixtureStage(input);
          const action = route ? (stage === 'running' ? 'queue' : 'dispatch') : 'ignore';
          if (stage !== 'relevance' || head.addressed || !route) {
            heads.push({ petId, messageId: head.message.messageId, action, stage, addressed: head.addressed });
          }
          if (stage === 'running') {
            assert.equal(petId, 'target');
            assert.equal(source, queuedRequest);
            assert.equal(head.execution?.status, 'running');
            assert.match(head.execution?.source?.body ?? '', /^ACTIVE_(HUMAN|PEER)$/);
            runningDecisions.push(head.message.messageId);
          }
          content = JSON.stringify(stage === 'relevance' ? { relevant: !!route }
            : stage === 'running' ? { delivery: route ? 'queue' : null, reply: null }
            : { shouldDispatch: !!route, reply: null });
        } else {
          const source = readChannelEnvelope(input.messages, text)?.message.body;
          const marker = source === 'EMIT_ACTIVE_PEER' ? 'SEED_ACTIVE' : source === 'EMIT_QUEUED_PEER' ? 'SEED_QUEUED'
            : source === queuedRequest ? 'QUEUED' : source === 'ACTIVE_HUMAN' || source === 'ACTIVE_PEER' ? 'ACTIVE'
            : input.messages.some(m => text(m.content).includes('ROUTE_ACTIVE')) ? 'ACTIVE' : undefined;
          assert.ok(marker);
          if (marker === 'SEED_ACTIVE') content = 'ACTIVE_PEER';
          else if (marker === 'SEED_QUEUED') content = queuedRequest;
          else if (marker === 'QUEUED') {
            queuedExecutions++;
            assert.equal(released, true, 'Queued input cannot replace or enter the still-active subject');
            content = 'RESULT_QUEUED';
          } else {
            const resultOf = (name: string) => {
              const ids = new Set(input.messages.flatMap(m => m.tool_calls ?? []).filter(c => c.function.name === name).map(c => c.id));
              return [...input.messages].reverse().find(m => m.role === 'tool' && !!m.tool_call_id && ids.has(m.tool_call_id));
            };
            if (names.includes('plan_request')) {
              call = { name: 'plan_request', args: { goal: 'ROUTE_ACTIVE' } };
            } else if (names.includes('submit_plan')) {
              if (!resultOf('submit_plan')) call = { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'ROUTE_ACTIVE' }] } };
              else if (!resultOf('delegate_capability')) call = { name: 'delegate_capability', args: { briefing: 'ROUTE_ACTIVE' } };
              else if (!resultOf('review_current')) { parentResumes++; call = { name: 'review_current', args: { completed: true, reason: 'Original synthetic subject completed.' } }; }
              else content = 'RESULT_ACTIVE';
            } else {
              assert.equal(held, false, 'Only one original delegated execution');
              hold = true; content = 'Original subject delivery ROUTE_ACTIVE';
            }
          }
        }
        const send = () => {
        const id = `scheduling-model-${++sequence}`;
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
        };
        if (hold) {
          held = true;
          response.once('close', () => { if (!response.writableEnded) aborted = true; });
          release = () => { if (released) return; released = true; send(); };
        } else send();
      } catch (error) {
        errors.push(error);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Synthetic scheduling request rejected' } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, heads, runningDecisions, errors,
    state: () => ({ held, aborted, queuedExecutions, parentResumes }), release: () => release(),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

for (const activeAuthor of ['human', 'peer'] as const) for (const queuedAuthor of ['human', 'peer'] as const) {
  test(`busy ${queuedAuthor} mention queues behind the active ${activeAuthor} subject without interrupting it`, { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-queued-peer-'));
    const model = await fixture();
    const channel = createChannelPlugin({ httpRoute: false });
    let built: Awaited<ReturnType<typeof buildStudio>> | undefined;
    const lifecycle: Array<{ state: string; sessionId?: string }> = [];
    try {
      const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: path.join(root, 'sessions'), checkpointPath: path.join(root, 'sessions/checkpoints.json'),
        tuiCheckpointPath: path.join(root, 'sessions/tui-checkpoints.json'), tuiSessionPath: path.join(root, 'sessions/tui-sessions.json') };
      built = await buildStudio({
        configuration: { workdir: root, studioConfigPath: path.join(root, '.pinpawo/studio.json'), petsDir: path.join(root, '.pinpawo/pets'),
          resolved: resolveStudio({ studioId: 'queued-peer', definitions: ['origin', 'target'], storage: { kind: 'sqlite', path: 'studio.sqlite' } },
            ['origin', 'target'].map(id => ({ definitionId: id, name: id }))), plugins: [channel] },
        modelProfiles: createTestModelProfiles({ baseUrl: model.baseUrl, model: 'synthetic-queued-peer', apiKey: 'synthetic-only', structuredOutputMethod: 'jsonMode', timeoutMs: 20_000, maxRetries: 0 }),
        hostCapabilities: [{ name: GENERAL_CAPABILITY_NAME, uses: ['channel'], description: 'Synthetic work', instructions: defineInstructionDocument({ content: 'Execute the synthetic task.' }) }],
        petCapabilities: new Map(), toolkitInventory: createTestHostToolkitInventory(channel.toolkits), checkpoint: new FileSaver(runtimeConfig.checkpointPath), runtimeConfig,
        toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      });
      const studio = built.studio;
      const channelId = (await channel.service.createChannel(human, { title: 'Synthetic scheduling', pets: [] })).channel.channelId;
      for (const petId of ['origin', 'target']) await studio.pets.create({ petId, definitionId: petId, name: petId, channelId });
      const target = built.residentPets.get('target')!;
      const readSnapshot = target.sessions.snapshot.bind(target.sessions);
      const sampled: string[] = [];
      target.sessions.snapshot = (sessionId, options) => {
        sampled.push(sessionId);
        return readSnapshot(sessionId, options);
      };
      target.resident.dispatch.onDispatchLifecycle(e => lifecycle.push({ state: e.state, sessionId: e.sessionId }));
      const messages = async () => (await channel.service.readContext(human, channelId, { limit: 100 })).messages;
      await channel.service.postMessage(human, channelId, { body: activeAuthor === 'human' ? 'ACTIVE_HUMAN' : 'EMIT_ACTIVE_PEER', mentions: [] });
      await until(() => model.state().held);
      const binding = await channel.service.getSession(channelId, 'target');
      assert.equal(binding?.registered, true);
      const original = (await messages()).find(m => m.body === (activeAuthor === 'human' ? 'ACTIVE_HUMAN' : 'ACTIVE_PEER'))!;
      assert.deepEqual(sampled, [], 'idle admission does not read Session contents');
      await channel.service.postMessage(human, channelId, { body: queuedAuthor === 'human' ? queuedRequest : 'EMIT_QUEUED_PEER', mentions: [] });
      await until(() => model.runningDecisions.length === 1 && target.resident.dispatch.getQueueSnapshot().queuedDispatches === 1);
      const queued = (await messages()).find(m => m.body === queuedRequest)!;
      assert.ok(queued);
      assert.equal(queued.author.kind, queuedAuthor === 'human' ? 'human' : 'pet');
      assert.deepEqual(queued.mentions.map(mention => mention.participantId), ['pet:target']);
      assert.deepEqual(model.heads.filter(turn => turn.petId === 'target' && turn.messageId === queued.messageId), [
        { petId: 'target', messageId: queued.messageId, action: 'queue', stage: 'running', addressed: true },
      ], 'canonical mention skips relevance, then chooses queue in the running branch');
      assert.deepEqual(sampled, [binding!.sessionId], 'busy work samples only the target’s exact Session once');
      assert.deepEqual(model.runningDecisions, [queued.messageId]);
      assert.equal(model.state().aborted, false);
      assert.equal(model.state().queuedExecutions, 0);
      assert.equal(lifecycle.filter(e => e.state === 'running').length, 1);
      assert.equal(lifecycle.filter(e => e.state === 'queued').length, 2);
      model.release();
      await until(() => lifecycle.filter(e => e.state === 'completed').length === 2);
      await until(async () => (await messages()).filter(m => m.author.id === 'target').length === 2);
      const final = await messages();
      const targetReplies = final.filter(m => m.author.kind === 'pet' && m.author.id === 'target');
      assert.deepEqual(targetReplies.map(m => m.body), ['RESULT_ACTIVE', 'RESULT_QUEUED']);
      await until(() => targetReplies.every(m => model.heads.some(h => h.petId === 'origin' && h.messageId === m.messageId && h.action === 'ignore')));
      assert.equal(model.state().aborted, false);
      assert.equal(model.state().parentResumes, 1, 'Original parent receives its delegated result without a second execution');
      assert.equal(model.state().queuedExecutions, 1, 'busy follow-up executes once after the original work');
      assert.equal(lifecycle.some(e => ['failed', 'interrupted', 'cancelled'].includes(e.state)), false);
      assert.equal(lifecycle.filter(e => e.state === 'message').length, 2);
      assert.ok(lifecycle.filter(e => e.state === 'completed').every(e => e.sessionId === binding!.sessionId));
      assert.equal((await channel.service.getSession(channelId, 'target'))?.sessionId, binding!.sessionId);
      const snapshot = await built.residentPets.get('target')!.sessions.snapshot(binding!.sessionId);
      assert.equal(snapshot.session.activeRun, null);
      const userMessages = snapshot.session.timeline.filter(e => e.type === 'message' && e.role === 'user');
      assert.ok(userMessages.some(e => e.type === 'message' && e.text.includes(original.messageId)));
      assert.equal(userMessages.some(e => e.type === 'message' && e.text.includes(queued.messageId)), true, 'queued work receives the original canonical message in the same Session');
      assert.deepEqual(model.errors, []);
    } finally {
      model.release();
      await built?.studio.shutdown();
      for (const resident of built?.residentPets.values() ?? []) await resident.close();
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
