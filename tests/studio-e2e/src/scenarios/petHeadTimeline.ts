import './isolateScenarioConfig';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineInstructionDocument, GENERAL_CAPABILITY_NAME } from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver } from 'pinpawo/host-runtime';
import { buildStudio } from '../../../../packages/studio/src/host/buildStudio';
import { resolveStudio } from '../../../../packages/studio/src/host/studioConfig';
import type { HeadInput, HeadMessage } from '../../../../packages/studio/src/host/petHead';
import { createChannelPlugin } from '../../../../plugins/channel/src/channelPlugin';
import { createTestModelProfiles } from '../../../../services/host/src/testing/modelProfiles';
import { createTestHostToolkitInventory } from '../../../../services/host/src/testing/toolkitInventory';

export type ScenarioCaseId = 'first-tool-call' | 'referenced-follow-up' | 'cross-channel-head-isolation';
export type ScenarioCaseResult = {
  id: ScenarioCaseId;
  status: 'passed' | 'failed' | 'blocked';
  checks: Record<string, boolean>;
  observations: Record<string, number | boolean>;
  failure?: 'timeout' | 'scenario-failed' | 'prerequisite-failed';
};
export type PetHeadTimelineTrialResult = { trial: number; cases: ScenarioCaseResult[] };
export type ScenarioModel = { baseUrl: string; model: string; apiKey?: string };

const human = { kind: 'human' as const, id: 'local' };
const petId = 'scenario-worker';
const tracingKeys = ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGFUSE_TRACING_ENABLED'];

class ScenarioTimeout extends Error {}
class ScenarioCancelled extends Error {}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (signal?.aborted) throw new ScenarioCancelled();
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new ScenarioTimeout();
}

function caseResult(id: ScenarioCaseId, checks: Record<string, boolean>, observations: Record<string, number | boolean>): ScenarioCaseResult {
  return { id, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, observations };
}

/** A fresh production Studio, resident Host, SQLite store and read-only fixture toolkit per trial. */
export async function runPetHeadTimelineTrial(input: {
  trial: number;
  model: ScenarioModel;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PetHeadTimelineTrialResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  let workdir: string | undefined;
  const tracing = tracingKeys.map(key => process.env[key]);
  for (const key of tracingKeys) process.env[key] = 'false';
  const cases: ScenarioCaseResult[] = [];
  let built: Awaited<ReturnType<typeof buildStudio>> | undefined;
  let currentCase: ScenarioCaseId = 'first-tool-call';
  const cancel = () => { void built?.studio.shutdown().catch(() => {}); };
  input.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (input.signal?.aborted) throw new ScenarioCancelled();
    workdir = await mkdtemp(path.join(tmpdir(), 'pet-head-scenario-'));
    const channel = createChannelPlugin({ httpRoute: false });
    const receipts: string[] = [];
    const lookupArgs: string[] = [];
    const lookup = tool(({ recordId }) => {
      // No filesystem, network, process or credential access is available to this tool.
      lookupArgs.push(recordId);
      const receipt = `synthetic-${randomUUID()}`;
      receipts.push(receipt);
      return JSON.stringify({ recordId, units: 7, receipt });
    }, {
      name: 'synthetic_lookup',
      description: 'Read the synthetic cobalt record. Returns units and a verification receipt; report both to the requester.',
      schema: z.object({ recordId: z.literal('cobalt') }),
    });
    const referenced: Array<{ replyTo: string; matched: boolean }> = [];
    const readContext = channel.head.readContext;
    channel.head.readContext = async (...args) => {
      const context = await readContext(...args);
      if (args[3]) referenced.push({ replyTo: args[3], matched: context.referencedMessage?.messageId === args[3] });
      return context;
    };
    const runtimeConfig = {
      ...buildHostRuntimeConfig(workdir),
      sessionRoot: path.join(workdir, 'sessions'),
      checkpointPath: path.join(workdir, 'sessions', 'checkpoints.json'),
      tuiCheckpointPath: path.join(workdir, 'sessions', 'tui-checkpoints.json'),
      tuiSessionPath: path.join(workdir, 'sessions', 'tui-sessions.json'),
    };
    built = await buildStudio({
      configuration: {
        workdir, studioConfigPath: path.join(workdir, '.pinpawo', 'studio.json'),
        petsDir: path.join(workdir, '.pinpawo', 'pets'),
        resolved: resolveStudio({ studioId: 'pet-head-scenario', definitions: ['worker'], storage: { kind: 'sqlite', path: 'studio.sqlite' } }, [
          { definitionId: 'worker', name: 'Scenario Worker' },
        ]),
        plugins: [channel],
      },
      modelProfiles: createTestModelProfiles({ ...input.model, apiKey: input.model.apiKey ?? 'scenario-only', timeoutMs, maxRetries: 0, structuredOutputMethod: 'jsonMode' }),
      hostCapabilities: [{
        name: GENERAL_CAPABILITY_NAME,
        description: 'Read one synthetic record and report its units and verification receipt.',
        uses: ['synthetic-records'],
        instructions: defineInstructionDocument({ content: 'Use synthetic_lookup to read the requested cobalt record. Report the exact returned verification receipt and units. All records are synthetic.' }),
      }],
      petCapabilities: new Map(),
      toolkitInventory: createTestHostToolkitInventory([{
        name: 'synthetic-records', description: 'Read-only synthetic records; no external resources.', tools: [{ tool: lookup }],
      }]),
      checkpoint: new FileSaver(runtimeConfig.checkpointPath), runtimeConfig,
      toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
    });
    if (input.signal?.aborted) {
      cancel();
      throw new ScenarioCancelled();
    }
    const studio = built.studio;
    const published: HeadMessage[] = [];
    const entries: HeadMessage[] = [];
    const completedEntries: string[] = [];
    const filters: Array<{ source: string; topic?: string } | undefined> = [];
    let headFailures = 0;
    const subscribe = studio.subscribe;
    let registering = false;
    studio.subscribe = (handler, filter) => {
      if (!registering) return subscribe(handler, filter);
      filters.push(filter);
      return subscribe(async event => {
        if (event.source === 'channel' && event.type === 'channel.message.created') entries.push(event.payload as HeadMessage);
        try { await handler(event); }
        catch { headFailures++; throw new Error('Scenario Head processing failed.'); }
        if (event.source === 'channel' && event.type === 'channel.message.created') completedEntries.push((event.payload as HeadMessage).messageId);
      }, filter);
    };
    subscribe(event => {
      if (event.source === 'channel' && event.type === 'channel.message.created') published.push(event.payload as HeadMessage);
    });
    const ownerId = (await channel.service.createChannel(human, { title: 'Synthetic records', pets: [] })).channel.channelId;
    registering = true;
    await studio.pets.create({ petId, definitionId: 'worker', name: 'Scenario Worker', channelId: ownerId });
    registering = false;
    const resident = built.residentPets.get(petId)!;
    const completed: string[] = [];
    let dispatchFailed = false;
    resident.resident.dispatch.onDispatchLifecycle(event => {
      if (event.state === 'completed') completed.push(event.sessionId ?? '');
      if (event.state === 'failed') dispatchFailed = true;
    });
    const outputs = async () => (await channel.service.readContext(human, ownerId, { limit: 100 })).messages
      .filter(message => message.author.kind === 'pet' && message.author.id === petId);
    const first = (await channel.service.postMessage(human, ownerId, {
      body: 'Look up the synthetic cobalt record using the available read-only tool. Report its units and exact verification receipt.',
    })).message;
    await waitFor(async () => headFailures > 0 || dispatchFailed || ((await outputs()).length >= 1 && completed.length >= 1), timeoutMs, input.signal);
    const firstReply = (await outputs())[0];
    const firstBinding = await channel.service.getSession(ownerId, petId);
    const firstCalls = lookupArgs.length;
    cases.push(caseResult('first-tool-call', {
      realToolExecuted: firstCalls === 1 && lookupArgs[0] === 'cobalt',
      resultReachedPublicReply: !!firstReply && !!receipts[0] && firstReply.body.includes(receipts[0]),
      unitsReachedPublicReply: !!firstReply && /\b7\b/.test(firstReply.body.replace(receipts[0] ?? '', '')),
      sessionRegistered: firstBinding?.registered === true,
      sourceReachedOwnerHead: entries.some(message => message.messageId === first.messageId),
      dispatchCompleted: completed.length === 1 && !dispatchFailed,
      headDecisionSucceeded: headFailures === 0,
      publicReplyDoesNotAutoLink: !!firstReply && firstReply.replyTo === undefined,
    }, { toolCalls: firstCalls, publicReplies: (await outputs()).length, publicReplyAutoLinked: !!firstReply?.replyTo, headFailures }));

    currentCase = 'referenced-follow-up';
    if (!firstReply || !firstBinding || cases[0]!.status !== 'passed') {
      cases.push({ id: currentCase, status: 'blocked', checks: {}, observations: {}, failure: 'prerequisite-failed' });
    } else {
      const followUp = (await channel.service.postMessage(human, ownerId, {
        body: 'For the record in the referenced answer, look it up again using the read-only tool and report its units and the new exact verification receipt.',
        replyTo: firstReply.messageId,
      })).message;
      await waitFor(async () => headFailures > 0 || dispatchFailed || ((await outputs()).length >= 2 && completed.length >= 2), timeoutMs, input.signal);
      const replies = await outputs();
      const secondBinding = await channel.service.getSession(ownerId, petId);
      const snapshot = await resident.sessions.snapshot(firstBinding.sessionId);
      const history = snapshot.session.timeline.filter(entry => entry.type === 'message');
      cases.push(caseResult(currentCase, {
        sameChannelSession: secondBinding?.sessionId === firstBinding.sessionId && completed[1] === firstBinding.sessionId,
        referenceReachedHead: referenced.some(value => value.replyTo === firstReply.messageId && value.matched),
        referenceRetainedInSession: history.some(entry => entry.role === 'user' && entry.text.includes(followUp.messageId) && entry.text.includes(firstReply.messageId)),
        priorAnswerRetained: history.some(entry => entry.role === 'assistant' && entry.text.includes(receipts[0]!)),
        freshReadWithoutReplay: lookupArgs.length - firstCalls === 1 && lookupArgs[1] === 'cobalt',
        freshResultReachedPublicReply: !!receipts[1] && !!replies[1] && replies[1].body.includes(receipts[1]),
        unitsReachedPublicReply: !!replies[1] && /\b7\b/.test(replies[1].body.replace(receipts[1] ?? '', '')),
        dispatchCompleted: completed.length === 2 && !dispatchFailed,
        headDecisionSucceeded: headFailures === 0,
        publicReplyDoesNotAutoLink: !!replies[1] && replies[1].replyTo === undefined,
      }, { toolCalls: lookupArgs.length - firstCalls, publicReplies: replies.length - 1, sameSession: secondBinding?.sessionId === firstBinding.sessionId,
        publicReplyAutoLinked: !!replies[1]?.replyTo, headFailures }));
    }

    currentCase = 'cross-channel-head-isolation';
    const foreignId = (await channel.service.createChannel(human, { title: 'Other synthetic Channel', pets: [] })).channel.channelId;
    const foreign = (await channel.service.postMessage(human, foreignId, { body: 'Synthetic foreign Channel message.' })).message;
    // A self-authored owner event is a FIFO barrier; production Head ignores it before model invocation.
    const barrier = (await channel.service.postMessage({ kind: 'pet', id: petId }, ownerId, { body: 'Synthetic owner delivery barrier.' })).message;
    await waitFor(() => completedEntries.includes(barrier.messageId), timeoutMs, input.signal);
    const foreignEntries = entries.filter(message => message.channelId === foreignId).length;
    cases.push(caseResult(currentCase, {
      foreignEventCommittedAndPublished: published.some(message => message.messageId === foreign.messageId),
      foreignEventNeverEnteredHeadHandler: foreignEntries === 0,
      ownerSubscriptionIsExact: filters.length === 1 && filters[0]?.source === 'channel' && filters[0]?.topic === ownerId,
      ownerHandlerStillActive: entries.some(message => message.messageId === barrier.messageId),
    }, { foreignHandlerEntries: foreignEntries, foreignPublishedEvents: published.filter(message => message.channelId === foreignId).length }));
  } catch (error) {
    if (!cases.some(result => result.id === currentCase)) cases.push({
      id: currentCase, status: 'failed', checks: {}, observations: input.signal?.aborted ? { cancelled: true } : {},
      failure: error instanceof ScenarioTimeout ? 'timeout' : 'scenario-failed',
    });
    for (const id of ['first-tool-call', 'referenced-follow-up', 'cross-channel-head-isolation'] as const) {
      if (!cases.some(result => result.id === id)) cases.push({ id, status: 'blocked', checks: {}, observations: input.signal?.aborted ? { cancelled: true } : {}, failure: 'prerequisite-failed' });
    }
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    let cleanupCompleted = true;
    try { await built?.studio.shutdown(); } catch { cleanupCompleted = false; }
    try { if (workdir) await rm(workdir, { recursive: true, force: true }); } catch { cleanupCompleted = false; }
    if (!cleanupCompleted && cases.length) {
      const result = cases.at(-1)!;
      result.status = 'failed';
      result.failure = 'scenario-failed';
      result.checks.cleanupCompleted = false;
    }
    for (const [index, key] of tracingKeys.entries()) {
      if (tracing[index] === undefined) delete process.env[key];
      else process.env[key] = tracing[index];
    }
  }
  return { trial: input.trial, cases };
}

type WireMessage = { role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type WireRequest = { model: string; stream?: boolean; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };

function wireText(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(block => block && typeof block === 'object' && 'text' in block ? String(block.text) : '').join('') : '';
}

/** Deterministic OpenAI wire fixture, selected by tool schemas and structured domain data. */
export async function createDeterministicScenarioModel(): Promise<ScenarioModel & { close(): Promise<void> }> {
  let sequence = 0;
  let supervisorStep = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      try {
        if (request.url !== '/v1/chat/completions') throw new Error('Unsupported fixture endpoint');
        const input = JSON.parse(body) as WireRequest;
        const names = input.tools?.map(entry => entry.function.name) ?? [];
        let content = '';
        let toolCall: { name: string; args: Record<string, unknown> } | undefined;
        if (names.length === 0) {
          const head = JSON.parse(wireText(input.messages.find(message => message.role === 'user')?.content)) as HeadInput;
          content = JSON.stringify({ action: 'dispatch', text: head.message.body });
        } else if (names.includes('plan_request')) {
          toolCall = { name: 'plan_request', args: { goal: 'Read the synthetic cobalt record and report its units and exact verification receipt.' } };
        } else if (names.includes('synthetic_lookup')) {
          const lookupIds = new Set(input.messages.flatMap(message => message.tool_calls ?? [])
            .filter(call => call.function.name === 'synthetic_lookup').map(call => call.id));
          const lookupResult = [...input.messages].reverse().find(message => message.role === 'tool' && !!message.tool_call_id && lookupIds.has(message.tool_call_id));
          if (!lookupResult) toolCall = { name: 'synthetic_lookup', args: { recordId: 'cobalt' } };
          else content = wireText(lookupResult.content);
        } else if (names.includes('submit_plan') || names.includes('review_current') || names.includes('delegate_capability')) {
          const step = supervisorStep++ % 4;
          if (step === 0) toolCall = { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Read the synthetic cobalt record.' }] } };
          else if (step === 1) toolCall = { name: 'delegate_capability', args: { briefing: 'Read the synthetic cobalt record with synthetic_lookup and report units and the exact receipt.' } };
          else if (step === 2) toolCall = { name: 'review_current', args: { completed: true, reason: 'The read-only lookup returned a synthetic record.' } };
          else {
            const delivery = [...input.messages].reverse().find(message => message.role === 'tool' && input.messages.some(item => item.tool_calls?.some(call => call.id === message.tool_call_id && call.function.name === 'delegate_capability')));
            content = delivery ? wireText(delivery.content) : 'Synthetic record read.';
          }
        } else throw new Error('Unknown fixture tool schema');
        const id = `scenario-call-${++sequence}`;
        const message = { role: 'assistant', content,
          ...(toolCall ? { tool_calls: [{ id, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } : {}),
        };
        const finish = toolCall ? 'tool_calls' : 'stop';
        if (input.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = { ...message, ...(toolCall ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : {}) };
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Deterministic scenario request rejected.' } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Scenario fixture failed to listen.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'scenario-fixture', apiKey: 'scenario-only',
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
