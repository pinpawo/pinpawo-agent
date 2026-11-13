import './isolateScenarioConfig';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defineInstructionDocument, GENERAL_CAPABILITY_NAME, readToolExecutionContext,
} from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { buildStudio } from '../../../../packages/studio/src/host/buildStudio';
import { resolveStudio } from '../../../../packages/studio/src/host/studioConfig';
import type { HeadInput, HeadMessage } from '../../../../packages/studio/src/host/petHead';
import { createChannelPlugin } from '../../../../plugins/channel/src/channelPlugin';
import { createTestModelProfiles } from '../../../../services/host/src/testing/modelProfiles';
import { createTestHostToolkitInventory } from '../../../../services/host/src/testing/toolkitInventory';
import { createFileToolDefinitions } from '../../../../services/host/src/toolkits/files';

type WireMessage = {
  role: string; content?: unknown; tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};
type WireRequest = { model: string; stream?: boolean; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };
const human = { kind: 'human' as const, id: 'local' };

function wireText(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(block => block && typeof block === 'object' && 'text' in block ? String(block.text) : '').join('') : '';
}

/** Only the model transport is scripted; all routing, execution and file reads are real. */
async function createWorkdirModel() {
  const decisions: Array<{ petId: string; channelId: string; messageId: string }> = [];
  const errors: unknown[] = [];
  let sequence = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/chat/completions');
        const input = JSON.parse(body) as WireRequest;
        const names = input.tools?.map(entry => entry.function.name) ?? [];
        const resultOf = (name: string) => {
          const ids = new Set(input.messages.flatMap(message => message.tool_calls ?? [])
            .filter(call => call.function.name === name).map(call => call.id));
          return [...input.messages].reverse().find(message => message.role === 'tool' && !!message.tool_call_id && ids.has(message.tool_call_id));
        };
        let content = '';
        let call: { name: string; args: Record<string, unknown> } | undefined;
        if (names.length === 0) {
          const { pet, message } = JSON.parse(wireText(input.messages.find(message => message.role === 'user')?.content)) as HeadInput;
          assert.equal(message.author.kind, 'human');
          decisions.push({ petId: pet.petId, channelId: message.channelId, messageId: message.messageId });
          content = JSON.stringify({ action: 'dispatch', text: message.body });
        } else if (names.includes('plan_request')) {
          call = { name: 'plan_request', args: { goal: 'Read marker.txt and report the exact result.' } };
        } else if (names.includes('view_file_chunk')) {
          // Expected file contents are never supplied by this model fixture.
          const read = resultOf('view_file_chunk');
          if (read) content = wireText(read.content);
          else call = { name: 'view_file_chunk', args: { path: 'marker.txt' } };
        } else if (names.includes('submit_plan') && names.includes('delegate_capability')) {
          // Use this request's own history, not a process-global step counter:
          // the two resident graphs are deliberately running concurrently.
          if (!resultOf('submit_plan')) call = { name: 'submit_plan', args: {
            tasks: [{ capability: 'general', objective: 'Read marker.txt with view_file_chunk.' }],
          } };
          else if (!resultOf('delegate_capability')) call = { name: 'delegate_capability', args: {
            briefing: 'Read the relative marker.txt file with view_file_chunk. Return its exact contents.',
          } };
          else if (!resultOf('review_current')) call = { name: 'review_current', args: {
            completed: true, reason: 'The read-only file tool returned the requested content.',
          } };
          else content = wireText(resultOf('delegate_capability')!.content);
        } else throw new Error('Unexpected workdir fixture model request.');
        const id = `workdir-call-${++sequence}`;
        const message = { role: 'assistant', content,
          ...(call ? { tool_calls: [{ id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}),
        };
        const finish = call ? 'tool_calls' : 'stop';
        if (input.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = { ...message, ...(call ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : {}) };
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: input.model,
            choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
      } catch (error) {
        errors.push(error);
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Workdir model fixture rejected a request.' } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'workdir-fixture', apiKey: 'workdir-fixture-only',
    decisions, errors,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

test('concurrent Channel Heads dispatch real relative file reads in their own workdirs and sessions', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'channel-workdir-timeline-'));
  const originalCwd = process.cwd();
  let built: Awaited<ReturnType<typeof buildStudio>> | undefined;
  let model: Awaited<ReturnType<typeof createWorkdirModel>> | undefined;
  let release!: () => void;
  const bothEntered = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<{
    workdir: string | null; threadId: string | null; petId: string; sessionId?: string;
    channelId?: string; input: unknown; output?: unknown;
  }> = [];
  try {
    const projects = [path.join(root, ' project-a '), path.join(root, 'project-b')];
    const markers = projects.map(() => `marker-${randomUUID()}`);
    await Promise.all(projects.map(async (directory, index) => {
      await mkdir(directory);
      await writeFile(path.join(directory, 'marker.txt'), markers[index]!);
    }));
    // A wrong management-root fallback must not accidentally look successful.
    await writeFile(path.join(root, 'marker.txt'), 'management-root-decoy');
    const channel = createChannelPlugin({ httpRoute: false });
    model = await createWorkdirModel();
    const definition = createFileToolDefinitions().inspection.find(item => item.tool.name === 'view_file_chunk')!;
    const invoke = Reflect.get(definition.tool, '_call', definition.tool);
    const observedTool = new Proxy(definition.tool, {
      get(target, property, receiver) {
        if (property !== '_call') return Reflect.get(target, property, receiver);
        return async (input: unknown, runManager: unknown, config: unknown) => {
          const { workdir, agentSessionId } = readToolExecutionContext(config);
          const invocation = readPetInvocationContext();
          assert.ok(invocation);
          assert.equal(invocation.scope?.namespace, 'channel');
          assert.deepEqual(input, { path: 'marker.txt' }, 'the real file tool receives an unresolved relative path');
          assert.ok(projects.includes(workdir!), 'only a Channel project may be read');
          const observation = {
            workdir, threadId: agentSessionId, petId: invocation.petId, sessionId: invocation.sessionId,
            channelId: invocation.scope?.id, input, output: undefined as unknown,
          };
          calls.push(observation);
          if (calls.length === 2) release();
          await bothEntered;
          observation.output = await invoke.call(definition.tool, input, runManager, config);
          return observation.output;
        };
      },
    });
    const runtimeConfig = {
      ...buildHostRuntimeConfig(root),
      sessionRoot: path.join(root, 'sessions'),
      checkpointPath: path.join(root, 'sessions', 'checkpoints.json'),
      tuiCheckpointPath: path.join(root, 'sessions', 'tui-checkpoints.json'),
      tuiSessionPath: path.join(root, 'sessions', 'tui-sessions.json'),
    };
    built = await buildStudio({
      configuration: {
        workdir: root, studioConfigPath: path.join(root, '.pinpawo', 'studio.json'), petsDir: path.join(root, '.pinpawo', 'pets'),
        resolved: resolveStudio({ studioId: 'channel-workdir-timeline', definitions: ['worker'], storage: { kind: 'sqlite', path: 'studio.sqlite' } },
          [{ definitionId: 'worker', name: 'Worker' }]),
        plugins: [channel],
      },
      modelProfiles: createTestModelProfiles({ baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey,
        timeoutMs: 5_000, maxRetries: 0, structuredOutputMethod: 'jsonMode' }),
      hostCapabilities: [{
        name: GENERAL_CAPABILITY_NAME, description: 'Read a requested text file and report the exact result.', uses: ['marker-files'],
        instructions: defineInstructionDocument({ content: 'Read marker.txt with view_file_chunk and report the exact returned contents.' }),
      }],
      petCapabilities: new Map(),
      toolkitInventory: createTestHostToolkitInventory([{
        name: 'marker-files', description: 'Only the read-only text file tool is available.', tools: [{ ...definition, tool: observedTool }],
      }]),
      checkpoint: new FileSaver(runtimeConfig.checkpointPath), runtimeConfig,
      toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    });
    const studio = built.studio;
    const published: HeadMessage[] = [];
    const terminal: Array<{ petId: string; state: string; sessionId?: string }> = [];
    studio.subscribe(event => {
      if (event.source === 'channel' && event.type === 'channel.message.created') published.push(event.payload as HeadMessage);
    });
    const owners = [];
    for (const [index, petId] of ['alpha', 'beta'].entries()) {
      const channelId = (await channel.service.createChannel(human, {
        title: petId, workdir: index === 0 ? path.relative(root, projects[index]!) : projects[index],
      }, { studio: true })).channel.channelId;
      await studio.pets.create({ petId, definitionId: 'worker', name: petId, channelId });
      built.residentPets.get(petId)!.resident.dispatch.onDispatchLifecycle(event => {
        if (event.state === 'completed' || event.state === 'failed') terminal.push({ petId, state: event.state, sessionId: event.sessionId });
      });
      owners.push({ petId, channelId, directory: projects[index]!, marker: markers[index]! });
    }
    const sources = await Promise.all(owners.map(owner => channel.service.postMessage(human, owner.channelId, {
      body: 'Read marker.txt using the available read-only tool and report its exact contents.',
    })));
    const deadline = Date.now() + 15_000;
    while (terminal.length < 2 || published.filter(message => message.author.kind === 'pet').length < 2) {
      assert.deepEqual(model.errors, []);
      assert.equal(terminal.some(event => event.state === 'failed'), false, 'both resident dispatches must succeed');
      assert.ok(Date.now() < deadline, 'both Heads must produce a public result');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(calls.length, 2, 'both real tools entered before either was released');
    assert.deepEqual(model.decisions.sort((a, b) => a.petId.localeCompare(b.petId)), owners.map((owner, index) => ({
      petId: owner.petId, channelId: owner.channelId, messageId: sources[index]!.message.messageId,
    })));
    const sessionIds = [];
    for (const owner of owners) {
      const binding = await channel.service.getSession(owner.channelId, owner.petId);
      assert.ok(binding?.registered);
      sessionIds.push(binding.sessionId);
      const execution = calls.find(call => call.petId === owner.petId);
      assert.ok(execution, 'the real tool uses its Channel session');
      assert.equal(execution.sessionId, binding.sessionId);
      assert.equal(execution.channelId, owner.channelId);
      assert.ok(execution.threadId);
      assert.equal(execution.workdir, owner.directory);
      assert.ok(String(execution.output).includes(owner.marker));
      const messages = (await channel.service.readContext(human, owner.channelId)).messages;
      const replies = messages.filter(message => message.author.kind === 'pet');
      assert.equal(replies.length, 1);
      assert.deepEqual(replies[0]!.author, { kind: 'pet', id: owner.petId });
      assert.ok(replies[0]!.body.includes(owner.marker), 'the public reply contains the actual file result');
      assert.ok(!JSON.stringify(messages).includes(owners.find(other => other !== owner)!.marker), 'the other Channel marker never enters this Timeline');
      assert.equal(terminal.find(event => event.petId === owner.petId)?.sessionId, binding.sessionId);
      const snapshot = await built.residentPets.get(owner.petId)!.sessions.snapshot(binding.sessionId);
      assert.equal(snapshot.session.runtime?.cwd, owner.directory);
      assert.equal(snapshot.session.runtime?.stateRoot, runtimeConfig.stateRoot);
      assert.equal(snapshot.session.runtime?.toolAuthorizationMode, 'require_authorization');
      assert.equal(await readFile(path.join(owner.directory, 'marker.txt'), 'utf8'), owner.marker, 'the tool remains read-only');
    }
    assert.equal(new Set(sessionIds).size, 2, 'the two Channel bindings use independent sessions');
    assert.equal(new Set(calls.map(call => call.threadId)).size, 2, 'the real tools use independent Agent threads');
    assert.equal(process.cwd(), originalCwd, 'execution never changes the process-global cwd');
    assert.deepEqual(model.errors, []);
  } finally {
    release();
    try { await built?.studio.shutdown(); }
    finally {
      try { await model?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});
