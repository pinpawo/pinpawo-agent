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
import type { HeadInput, HeadMessage } from '../../../../packages/studio/src/host/petHead';
import { createChannelPlugin } from '../../../../plugins/channel/src/channelPlugin';
import { createTestModelProfiles } from '../../../../services/host/src/testing/modelProfiles';
import { createTestHostToolkitInventory } from '../../../../services/host/src/testing/toolkitInventory';

// Manually invoked scenario only. The corpus is synthetic, not an owner's text.
const philosophers = [
  { petId: 'roundtable-language', definitionId: 'language', name: '维特根斯坦', answer: '规则的共同使用不等于对世界的复制。' },
  { petId: 'roundtable-conditions', definitionId: 'conditions', name: '康德', answer: '共同经验需要条件，不能从一致推到物自身。' },
  { petId: 'roundtable-being', definitionId: 'being', name: '海德格尔', answer: '可计算的表象不能穷尽在世的显现。' },
] as const;
const human = { kind: 'human' as const, id: 'local' };
const question = '合成讨论：请把“集体感知共识”理解为感知实践、共享概念与纠错规则共同构成的认识条件，而非多数投票。当预测系统与这种共识吻合时，是否足以断言两者具有相同的理解？请从自己的角色给出一个区分。';
type WireMessage = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type WireRequest = { model: string; stream?: boolean; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };
function text(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(block => block && typeof block === 'object' && 'text' in block ? String(block.text) : '').join('') : '';
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 25_000;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error('Roundtable scenario timed out.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Script only model decisions/content. Runtime, queues, SQLite and session snapshots are production. */
async function scriptedModel() {
  const decisions: Array<{ petId: string; channelId: string; messageId: string; action: string; mentioned: boolean }> = [];
  const modelErrors: unknown[] = [];
  let sequence = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/chat/completions');
        const input = JSON.parse(raw) as WireRequest;
        const names = input.tools?.map(item => item.function.name) ?? [];
        let head: HeadInput | undefined;
        for (const message of input.messages) {
          if (message.role !== 'user') continue;
          try { const value = JSON.parse(text(message.content)); if (value.pet?.petId && value.message?.messageId && value.context) head = value; } catch { /* Execution is not a Head request. */ }
        }
        let content = '';
        let call: { name: string; args: Record<string, unknown> } | undefined;
        if (head) {
          const peerEligible = head.message.author.kind === 'pet'
            && head.message.author.id === 'roundtable-language'
            && head.message.body.includes('RESULT_2_roundtable-language')
            && head.pet.petId === 'roundtable-being';
          const round = peerEligible ? 3 : head.message.body === question ? 1 : head.message.body.startsWith('合成同伴回应：') ? 2 : 0;
          const eligible = peerEligible || (head.message.author.kind === 'human' && round > 0);
          const action = eligible ? (round === 2 && head.pet.petId === 'roundtable-conditions' ? 'dispatch' : 'reply') : 'ignore';
          decisions.push({ petId: head.pet.petId, channelId: head.message.channelId, messageId: head.message.messageId, action,
            mentioned: head.message.mentions.some(item => item.participantId === `pet:${head!.pet.petId}`) });
          content = JSON.stringify({ action, text: eligible ? `Execute a concise philosophical response. ROUND_${round}_${head.pet.petId}. Preserve the source and quoted peer context; do not output routing instructions.` : '' });
        } else {
          const all = input.messages.map(message => text(message.content)).join('\n');
          const marker = [...all.matchAll(/ROUND_([123])_(roundtable-(?:language|conditions|being))/g)].at(-1);
          assert.ok(marker, 'Execution must receive its Head routing request');
          const round = Number(marker[1]);
          const role = philosophers.find(item => item.petId === marker[2])!;
          const answer = round === 1 ? `${role.name}：${role.answer} RESULT_1_${role.petId}`
            : round === 2 ? `${role.name}回应维特根斯坦的“规则的共同使用”：共同规则允许纠错，却不能单凭一致证明理解相同。RESULT_2_${role.petId}`
            : `${role.name}直接回应维特根斯坦的同伴发言：纠错规则的成立还预设了我们共同置身的意义世界。RESULT_3_${role.petId}`;
          const resultOf = (name: string) => {
            const ids = new Set(input.messages.flatMap(message => message.tool_calls ?? []).filter(item => item.function.name === name).map(item => item.id));
            return [...input.messages].reverse().find(message => message.role === 'tool' && !!message.tool_call_id && ids.has(message.tool_call_id));
          };
          if (names.includes('plan_request')) call = { name: 'plan_request', args: { goal: marker[0] } };
          else if (names.includes('submit_plan') && names.includes('delegate_capability')) {
            if (!resultOf('submit_plan')) call = { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: marker[0] }] } };
            else if (!resultOf('delegate_capability')) call = { name: 'delegate_capability', args: { briefing: marker[0] } };
            else if (!resultOf('review_current')) call = { name: 'review_current', args: { completed: true, reason: 'The synthetic philosophical response is complete.' } };
            else content = answer;
          } else content = answer;
        }
        const id = `roundtable-model-${++sequence}`;
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
        modelErrors.push(error);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Synthetic roundtable request rejected.' } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'roundtable-fixture', decisions, modelErrors,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test('manual three-Pet roundtable routes dialogue through retained execution sessions, including unmentioned decisions', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-roundtable-eval-'));
  const model = await scriptedModel();
  const channel = createChannelPlugin({ httpRoute: false });
  let built: Awaited<ReturnType<typeof buildStudio>> | undefined;
  let directHeadWrites = 0;
  const directReply = channel.head.reply;
  channel.head.reply = async (...args) => { directHeadWrites++; return directReply(...args); };
  const referenced: Array<{ petId: string; replyTo: string; found: boolean }> = [];
  const readContext = channel.head.readContext;
  channel.head.readContext = async (...args) => {
    const context = await readContext(...args);
    if (args[3]) referenced.push({ petId: args[1], replyTo: args[3], found: context.referencedMessage?.messageId === args[3] });
    return context;
  };
  try {
    const runtimeConfig = { ...buildHostRuntimeConfig(root), sessionRoot: path.join(root, 'sessions'),
      checkpointPath: path.join(root, 'sessions', 'checkpoints.json'), tuiCheckpointPath: path.join(root, 'sessions', 'tui-checkpoints.json'), tuiSessionPath: path.join(root, 'sessions', 'tui-sessions.json') };
    built = await buildStudio({
      configuration: { workdir: root, studioConfigPath: path.join(root, '.pinpawo/studio.json'), petsDir: path.join(root, '.pinpawo/pets'),
        resolved: resolveStudio({ studioId: 'roundtable-eval', definitions: philosophers.map(role => role.definitionId), storage: { kind: 'sqlite', path: 'studio.sqlite' } },
          philosophers.map(role => ({ definitionId: role.definitionId, name: role.name }))), plugins: [channel] },
      modelProfiles: createTestModelProfiles({ baseUrl: model.baseUrl, model: model.model, apiKey: 'synthetic-only', timeoutMs: 20_000, maxRetries: 0, structuredOutputMethod: 'jsonMode' }),
      hostCapabilities: [{ name: GENERAL_CAPABILITY_NAME, uses: ['channel'], description: 'Produce a concise synthetic philosophical response.',
        instructions: defineInstructionDocument({ content: 'Answer the current synthetic request as this Pet. No external resources or tools are required.' }) }],
      petCapabilities: new Map(), toolkitInventory: createTestHostToolkitInventory([]),
      checkpoint: new FileSaver(runtimeConfig.checkpointPath), runtimeConfig,
      toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
    });
    const studio = built.studio;
    const ownerId = (await channel.service.createChannel(human, { title: 'Synthetic collective-experience roundtable', pets: [] })).channel.channelId;
    const foreignId = (await channel.service.createChannel(human, { title: 'Unrelated synthetic Channel', pets: [] })).channel.channelId;
    const completed = new Map<string, string[]>();
    const failed: string[] = [];
    for (const role of philosophers) {
      await studio.pets.create({ ...role, channelId: ownerId });
      completed.set(role.petId, []);
      built.residentPets.get(role.petId)!.resident.dispatch.onDispatchLifecycle(event => {
        if (event.state === 'completed') completed.get(role.petId)!.push(event.sessionId ?? '');
        if (event.state === 'failed') failed.push(role.petId);
      });
    }
    for (const role of philosophers) assert.equal(await channel.service.getSession(ownerId, role.petId), undefined, 'Binding is lazy before the first execution');
    const replies = async () => (await channel.service.readContext(human, ownerId, { limit: 100 })).messages.filter(message => message.author.kind === 'pet');
    // Only one mention: the other two replies must arise from their controlled model eligibility, not a blanket all-respond rule.
    const first = (await channel.service.postMessage(human, ownerId, { body: question, mentions: [{ participantId: `pet:${philosophers[0].petId}` }] })).message;
    await until(async () => (await replies()).length >= 3 && [...completed.values()].every(value => value.length >= 1));
    const firstReplies = await replies();
    assert.equal(firstReplies.length, 3);
    const bindings = new Map<string, string>();
    for (const role of philosophers) {
      const actual = firstReplies.filter(message => message.author.id === role.petId);
      assert.equal(actual.length, 1, 'One attributed execution answer per eligible Pet');
      assert.ok(actual[0]!.body.includes(`RESULT_1_${role.petId}`));
      assert.equal(actual[0]!.body.includes(`ROUND_1_${role.petId}`), false, 'The executed answer is distinct from Head routing intent');
      assert.ok(actual[0]!.externalRef, 'Final answer must come from execution delivery');
      // TODO: execution delivery currently omits outgoing replyTo; this is a known acceptance gap.
      assert.equal(actual[0]!.replyTo, undefined, 'Known gap: execution output is not yet correlated to its triggering human message');
      const binding = await channel.service.getSession(ownerId, role.petId);
      assert.equal(binding?.registered, true);
      bindings.set(role.petId, binding!.sessionId);
    }
    assert.equal(new Set(bindings.values()).size, 3);
    assert.equal(directHeadWrites, 0, 'Routing text must never be published as a final Head answer');
    assert.equal(model.decisions.filter(item => item.messageId === first.messageId && !item.mentioned && item.action === 'reply').length, 2);

    const peer = firstReplies.find(message => message.author.id === philosophers[0].petId)!;
    const second = (await channel.service.postMessage(human, ownerId, {
      body: '合成同伴回应：请针对所引用的维特根斯坦观点，各自给出一个具体限定；答完等待人类。', replyTo: peer.messageId, mentions: [],
    })).message;
    await until(async () => (await replies()).length >= 7 && philosophers.every(role => completed.get(role.petId)!.length >= (role.petId === 'roundtable-being' ? 3 : 2)));
    assert.ok(model.decisions.some(entry => entry.messageId === second.messageId && entry.petId === 'roundtable-conditions' && entry.action === 'dispatch'));
    assert.ok(model.decisions.some(entry => entry.messageId === second.messageId && entry.petId === 'roundtable-language' && entry.action === 'reply'));
    const secondReplies = (await replies()).filter(message => message.body.includes('RESULT_2_'));
    assert.equal(secondReplies.length, 3);
    for (const role of philosophers) {
      const reply = secondReplies.filter(message => message.author.id === role.petId);
      assert.equal(reply.length, 1);
      assert.ok(reply[0]!.body.includes(`RESULT_2_${role.petId}`));
      assert.ok(reply[0]!.body.includes('规则的共同使用'));
      assert.equal(reply[0]!.replyTo, undefined, 'Known gap: execution output omits triggering follow-up replyTo');
      assert.ok(referenced.some(entry => entry.petId === role.petId && entry.replyTo === peer.messageId && entry.found));
      const binding = await channel.service.getSession(ownerId, role.petId);
      assert.equal(binding?.sessionId, bindings.get(role.petId));
      assert.deepEqual(completed.get(role.petId), Array(role.petId === 'roundtable-being' ? 3 : 2).fill(binding!.sessionId));
      const snapshot = await built.residentPets.get(role.petId)!.sessions.snapshot(binding!.sessionId);
      const history = snapshot.session.timeline.filter(entry => entry.type === 'message');
      assert.ok(history.some(entry => entry.role === 'user' && entry.text.includes(first.messageId)));
      assert.ok(history.some(entry => entry.role === 'user' && entry.text.includes(second.messageId) && entry.text.includes(peer.messageId)));
      assert.equal(snapshot.session.activeRun, null);
    }
    // A real Pet execution publication, not a human quote, triggers exactly one peer execution.
    const peerTrigger = secondReplies.find(message => message.author.id === 'roundtable-language')!;
    const peerResponses = (await replies()).filter(message => message.body.includes('RESULT_3_'));
    assert.equal(peerResponses.length, 1);
    const peerResponse = peerResponses[0]!;
    assert.equal(peerResponse.author.id, 'roundtable-being');
    assert.equal(peerResponse.replyTo, undefined, 'Known gap: peer execution output omits triggering Pet message replyTo');
    assert.ok(model.decisions.some(entry => entry.messageId === peerTrigger.messageId
      && entry.petId === 'roundtable-being' && !entry.mentioned && entry.action === 'reply'));
    const peerSession = await built.residentPets.get('roundtable-being')!.sessions.snapshot(bindings.get('roundtable-being')!);
    assert.ok(peerSession.session.timeline.some(entry => entry.type === 'message'
      && entry.role === 'user' && entry.text.includes(peerTrigger.messageId)));
    // Script an explicit stop on the new Pet output. This is not evidence of live-model loop safety.
    await until(() => philosophers.filter(role => role.petId !== peerResponse.author.id).every(role => model.decisions.some(entry => entry.petId === role.petId
      && entry.messageId === peerResponse.messageId && entry.action === 'ignore')));
    assert.equal(model.decisions.some(entry => entry.petId === peerResponse.author.id
      && entry.messageId === peerResponse.messageId), false, 'Production self-author guard suppresses own-output routing');
    const foreign = (await channel.service.postMessage(human, foreignId, { body: 'Synthetic unrelated message.' })).message;
    const ignored = (await channel.service.postMessage(human, ownerId, { body: 'Synthetic housekeeping, no discussion requested.', mentions: [] })).message;
    await until(() => philosophers.every(role => model.decisions.some(entry => entry.petId === role.petId && entry.messageId === ignored.messageId && entry.action === 'ignore')));
    assert.equal(model.decisions.some(entry => entry.messageId === foreign.messageId), false);
    assert.equal((await replies()).length, 7, 'The scripted peer turn and explicit ignore stop must not create extra replies');
    assert.equal(directHeadWrites, 0);
    assert.deepEqual(failed, []);
    assert.deepEqual(model.modelErrors, []);
  } finally {
    await built?.studio.shutdown();
    for (const resident of built?.residentPets.values() ?? []) await resident.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
