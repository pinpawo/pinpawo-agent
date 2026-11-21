import './isolateScenarioConfig';
import { readChannelEnvelope, type ChannelEnvelope } from './channelWire';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineInstructionDocument, definePetDocument, GENERAL_CAPABILITY_NAME } from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver } from 'pinpawo/host-runtime';
import { buildStudio } from '../../../../packages/studio/src/host/buildStudio';
import { resolveStudio } from '../../../../packages/studio/src/host/studioConfig';
import type { HeadInput, HeadReplyInput } from '../../../../packages/studio/src/host/petHead';
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
const question = '合成讨论：请把“集体感知共识”理解为感知实践、共享概念与纠错规则共同构成的认识条件，而非多数投票。当预测系统与这种共识吻合时，是否足以断言两者具有相同的理解？请各位回复，从自己的角色给出一个区分。';
const followup = '合成同伴回应：请针对所引用的维特根斯坦观点，各自给出一个具体限定；答完等待人类。';
const peerReport = [
  '维特根斯坦回应“规则的共同使用”：共同规则允许纠错，却不能单凭一致证明理解相同。RESULT_2_roundtable-language',
  '## 独立核查材料',
  '| 编号 | 可观察行为 | 论证边界 |',
  '| --- | --- | --- |',
  ...Array.from({ length: 104 }, (_, index) => `| ${index + 1} | 样本只记录公开的共同判断和纠错。 | 这个结果说明可预测性，不说明主体对规则的理解。边界：不要用一致性替代解释。 |`),
  '示例：\n\n```text\n共同判断并不是思想等同。\n```',
  '[@海德格尔](participant:pet:roundtable-being) 请独立核查上面完整报告的论证，列出至少一个证据缺口。',
].join('\n\n');
type WireMessage = { role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type HeadWireMode = 'tool' | 'json';
type WireRequest = { model: string; stream?: boolean; response_format?: { type: string }; tool_choice?: unknown; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };
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
async function scriptedModel(mode: HeadWireMode) {
  const attempts = new Map<string, number>();
  const decisions: Array<{ petId: string; channelId: string; messageId: string; action: string; mentioned: boolean }> = [];
  const compositions = new Map<string, number>();
  const reviewed = new Map<string, ChannelEnvelope>();
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
        let compose: HeadReplyInput | undefined;
        for (const message of input.messages) {
          if (message.role !== 'user') continue;
          try {
            const value = JSON.parse(text(message.content));
            if (value.pet?.petId && value.message?.messageId && value.context) head = value;
            else if (value.message?.messageId && value.evidence) compose = value;
          } catch { /* Execution is not a Head request. */ }
        }
        let content = '';
        let call: { name: string; args: Record<string, unknown> } | undefined;
        if (head) {
          const key = `${head.pet.petId}:${head.message.messageId}`;
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          assert.equal(attempt, 1, 'One model request per Head decision');
          assert.ok(head.context.messages.every(entry => entry.sequence < head!.message.sequence), 'Current message is not duplicated in Head history');
          if (mode === 'tool') {
            assert.deepEqual(names, ['pet_head_decision'], 'Only the decision schema tool is bound');
            assert.deepEqual(input.tool_choice, { type: 'function', function: { name: 'pet_head_decision' } });
          } else {
            assert.deepEqual(names, []);
            assert.deepEqual(input.response_format, { type: 'json_object' });
          }
          if (head.pet.petId === 'roundtable-being' && head.message.body.includes('RESULT_2_roundtable-language')) {
            assert.equal(head.message.body, peerReport);
            assert.equal(head.addressed, true, 'Canonical mention survives the resident report Markdown');
          }
          const peerEligible = head.message.author.kind === 'pet'
            && head.message.author.id === 'roundtable-language'
            && head.message.body === peerReport
            && head.addressed
            && head.pet.petId === 'roundtable-being';
          const round = peerEligible ? 3 : head.message.body === question ? 1 : head.message.body === followup ? 2 : 0;
          const eligible = peerEligible || (head.message.author.kind === 'human' && round > 0);
          const action = eligible ? 'dispatch' : 'ignore';
          decisions.push({ petId: head.pet.petId, channelId: head.message.channelId, messageId: head.message.messageId, action,
            mentioned: head.message.mentions.some(item => item.participantId === `pet:${head!.pet.petId}`) });
          const decision = { action };
          if (mode === 'tool') call = { name: 'pet_head_decision', args: decision };
          else content = JSON.stringify(decision);
        } else if (compose) {
          assert.deepEqual(names, []);
          assert.equal(input.tool_choice, undefined);
          assert.equal(input.response_format, undefined);
          assert.ok(!input.stream);
          assert.deepEqual(Object.keys(compose).sort(), compose.source ? ['evidence', 'message', 'source'] : ['evidence', 'message']);
          assert.ok(['running', 'unavailable'].includes(compose.evidence.status));
          assert.deepEqual(Object.keys(compose.evidence), ['status']);
          if (compose.source) {
            assert.equal(compose.evidence.status, 'running');
            assert.deepEqual(Object.keys(compose.source).sort(), ['body', 'messageId']);
          }
          const { messageId } = compose.message;
          const count = (compositions.get(messageId) ?? 0) + 1;
          compositions.set(messageId, count);
          assert.ok(count <= decisions.filter(entry => entry.messageId === messageId && entry.action === 'dispatch').length,
            'At most one unbound composition per handling decision');
          // The roundtable requests new work, not a status update.
        } else {
          const all = input.messages.map(message => text(message.content)).join('\n');
          const envelope = readChannelEnvelope(input.messages, text);
          const roleFromIdentity = philosophers.find(role => input.messages.some(item => item.role === 'system'
            && text(item.content).includes(`Synthetic roundtable identity: ${role.petId}.`)));
          const role = roleFromIdentity ?? philosophers.find(item => all.includes(`ROUND_1_${item.petId}`)
            || all.includes(`ROUND_2_${item.petId}`) || all.includes(`ROUND_3_${item.petId}`));
          assert.ok(role, 'The synthetic runtime Pet has a distinct role');
          const source = envelope?.message;
          const round = source ? source.body === question ? 1 : source.body === followup ? 2 : source.body === peerReport ? 3 : undefined
            : [...all.matchAll(/ROUND_([123])_roundtable-(?:language|conditions|being)/g)].at(-1)?.[1];
          assert.ok(round, 'Execution receives the canonical Channel message or its own delegated instruction');
          const phase = Number(round);
          const marker = `ROUND_${phase}_${role.petId}`;
          if (names.includes('plan_request') && phase === 3) {
            assert.ok(envelope);
            assert.equal(role.petId, 'roundtable-being');
            assert.deepEqual(source!.author, { kind: 'pet', id: 'roundtable-language' });
            assert.equal(source!.body, peerReport, 'The provider sees the complete report Markdown');
            assert.deepEqual(source!.mentions.map(item => item.participantId), ['pet:roundtable-being']);
            assert.ok(!reviewed.has(source!.messageId), 'One review admission for the canonical source ID');
            reviewed.set(source!.messageId, envelope);
          }
          const answer = phase === 1 ? `${role.name}：${role.answer} RESULT_1_${role.petId}`
            : phase === 2 ? (role.petId === 'roundtable-language' ? peerReport
              : `${role.name}回应维特根斯坦的“规则的共同使用”：共同规则允许纠错，却不能单凭一致证明理解相同。RESULT_2_${role.petId}`)
            : `${role.name}直接回应维特根斯坦的同伴发言：纠错规则的成立还预设了我们共同置身的意义世界。RESULT_3_${role.petId}`;
          const resultOf = (name: string) => {
            const ids = new Set(input.messages.flatMap(message => message.tool_calls ?? []).filter(item => item.function.name === name).map(item => item.id));
            return [...input.messages].reverse().find(message => message.role === 'tool' && !!message.tool_call_id && ids.has(message.tool_call_id));
          };
          if (names.includes('plan_request')) call = { name: 'plan_request', args: { goal: marker } };
          else if (names.includes('submit_plan') && names.includes('delegate_capability')) {
            if (!resultOf('submit_plan')) call = { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: marker }] } };
            else if (!resultOf('delegate_capability')) call = { name: 'delegate_capability', args: { briefing: marker } };
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'roundtable-fixture', decisions, attempts, compositions, reviewed, modelErrors,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

for (const mode of ['tool', 'json'] as const) {
test(`manual three-Pet roundtable retains execution sessions and bounded ${mode} Head decisions`, { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-roundtable-eval-'));
  const model = await scriptedModel(mode);
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
      modelProfiles: createTestModelProfiles({ baseUrl: model.baseUrl, model: model.model, apiKey: 'synthetic-only', timeoutMs: 20_000, maxRetries: 0, structuredOutputMethod: mode === 'tool' ? 'functionCalling' : 'jsonMode' }),
      hostCapabilities: [{ name: GENERAL_CAPABILITY_NAME, uses: ['channel'], description: 'Produce a concise synthetic philosophical response.',
        instructions: defineInstructionDocument({ content: 'Answer the current synthetic request as this Pet. No external resources or tools are required.' }) }],
      petDocuments: new Map(philosophers.map(role => [role.definitionId, definePetDocument({ content: `# Synthetic Pet\nSynthetic roundtable identity: ${role.petId}.` })])),
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
      assert.ok(actual[0]!.externalRef, 'Final answer must come from execution delivery');
      // TODO: execution delivery currently omits outgoing replyTo; this is a known acceptance gap.
      assert.equal(actual[0]!.replyTo, undefined, 'Known gap: execution output is not yet correlated to its triggering human message');
      const binding = await channel.service.getSession(ownerId, role.petId);
      assert.equal(binding?.registered, true);
      bindings.set(role.petId, binding!.sessionId);
    }
    assert.equal(new Set(bindings.values()).size, 3);
    assert.equal(directHeadWrites, 0, 'Routing text must never be published as a final Head answer');
    assert.equal(model.decisions.filter(item => item.messageId === first.messageId && !item.mentioned && item.action === 'dispatch').length, 2);

    const peer = firstReplies.find(message => message.author.id === philosophers[0].petId)!;
    const second = (await channel.service.postMessage(human, ownerId, {
      body: followup, replyTo: peer.messageId, mentions: [],
    })).message;
    await until(async () => (await replies()).length >= 7 && philosophers.every(role => completed.get(role.petId)!.length >= (role.petId === 'roundtable-being' ? 3 : 2)));
    assert.ok(model.decisions.some(entry => entry.messageId === second.messageId && entry.petId === 'roundtable-conditions' && entry.action === 'dispatch'));
    assert.ok(model.decisions.some(entry => entry.messageId === second.messageId && entry.petId === 'roundtable-language' && entry.action === 'dispatch'));
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
    assert.ok(peerReport.length >= 5000 && peerReport.length <= 10000);
    assert.deepEqual([...model.reviewed.values()], [{ type: 'channel_message', version: 1, message: peerTrigger }],
      'The review Agent provider gets only the canonical source envelope, with exact body, source ID, and Pet author');
    const peerResponses = (await replies()).filter(message => message.body.includes('RESULT_3_'));
    assert.equal(peerResponses.length, 1);
    const peerResponse = peerResponses[0]!;
    assert.equal(peerResponse.author.id, 'roundtable-being');
    assert.equal(peerResponse.replyTo, undefined, 'Known gap: peer execution output omits triggering Pet message replyTo');
    assert.ok(model.decisions.some(entry => entry.messageId === peerTrigger.messageId
      && entry.petId === 'roundtable-being' && entry.mentioned && entry.action === 'dispatch'));
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
    for (const [messageId, count] of model.compositions) {
      assert.ok([second.messageId, peerTrigger.messageId].includes(messageId), 'Idle work and declined turns do not require composition');
      assert.ok(count <= (messageId === second.messageId ? philosophers.length : 1));
    }
    assert.ok(model.attempts.size > 0);
    for (const count of model.attempts.values()) assert.equal(count, 1);
  } finally {
    await built?.studio.shutdown();
    for (const resident of built?.residentPets.values() ?? []) await resident.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
}
