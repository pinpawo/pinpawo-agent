import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { defineInstructionDocument } from '@pinpawo/pet-agent';
import type { AgentServerMessage } from '@pinpawo/agent-session';
import { buildHostRuntimeConfig, createResidentPetHost, FilePetCredentialSource, FileSaver } from '../../../services/host/src/hostRuntime';
import { HostGraphService, type InterruptResume } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { createShellToolkit } from '../../../services/host/src/toolkits/shell';
import { ShellRSClient } from '../../../services/host/src/toolkits/shellRS/shellRSClient';
import { PosixShellRS } from '../../../services/host/src/toolkits/shellRS/posixShellRS';
import { createShellRSServiceHandler } from '../../../services/host/src/toolkits/shellRS/shellRSService';
import { SHELL_RS_CONTRACT, SHELL_RS_VERSION } from '../../../services/host/src/toolkits/shellRS/shellRS';
import { resolveRSServicePaths } from '../../../services/host/src/rsService/paths';
import { RSServiceConnection } from '../../../services/host/src/rsService/connection';
import { startRSService } from '../../../services/host/src/rsService/server';

class ScriptedModel extends BaseChatModel {
  private calls = 0;
  constructor(private readonly respond: (messages: BaseMessage[], index: number) => AIMessage) { super({}); }
  _llmType() { return 'credential-resume-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = this.respond(messages, this.calls++);
    return { generations: [{ message, text: message.text }] };
  }
}
const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for credential graph review/resume.');
}

async function assertFilesExclude(root: string, secret: string) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await assertFilesExclude(path, secret);
    else if (entry.isFile()) assert.equal((await readFile(path)).includes(Buffer.from(secret)), false, `secret in ${path}`);
  }
}

test('real graph review/resume injects the admitted instance credential only at ShellRS exec',
  { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pet-credential-graph-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const secret = `fake-credential-${randomUUID()}`;
    const sourcePath = join(root, 'private-source.json');
    await writeFile(sourcePath, JSON.stringify({
      bindings: { 'credential-pet': { PET_TEST_TOKEN: 'account-ref' } },
      values: { 'account-ref': secret },
    }), { mode: 0o600 });
    const source = new FilePetCredentialSource(sourcePath);
    const resolvedInstances: string[] = [];
    const paths = resolveRSServicePaths(join(root, 'rs'));
    await mkdir(paths.root, { mode: 0o700 });
    const rsToken = 'fake-rs-transport-token';
    const service = await startRSService({ endpoint: paths.endpoint, token: rsToken,
      handlers: [createShellRSServiceHandler(new PosixShellRS())], log: () => {}, });
    t.after(() => service.stop());
    const shell = new ShellRSClient({
      credentialSource: {
        readBindings: async petId => { resolvedInstances.push(petId); return source.readBindings(petId); },
        resolve: ref => source.resolve(ref),
      },
      connect: () => RSServiceConnection.open({ paths, token: rsToken,
        rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION } }),
    });
    t.after(() => shell.dispose());
    await shell.start();
    const runtimeConfig = buildHostRuntimeConfig(join(root, 'work'));
    await mkdir(runtimeConfig.workdir, { recursive: true });
    const proofPath = join(runtimeConfig.workdir, 'credential-digest.txt');
    // The command contains no secret literal and emits only a constant success marker.
    // Its separate digest side effect proves the real child received the expected value.
    await writeFile(join(runtimeConfig.workdir, 'use-credential.cjs'), [
      "const { createHash } = require('node:crypto');",
      "require('node:fs').writeFileSync('credential-digest.txt', createHash('sha256').update(process.env.PET_TEST_TOKEN || '').digest('hex'));",
      "process.stdout.write('credential-used');",
    ].join('\n'));
    const inventory = await buildHostToolkitInventory({ sources: [{
      id: 'test-shell', kind: 'host_builtin', definitions: [createShellToolkit({ shell })],
    }] });
    const modelMessages: string[] = [];
    const observe = (messages: BaseMessage[]) => { modelMessages.push(JSON.stringify(messages)); };
    const entry = new ScriptedModel(messages => {
      observe(messages);
      return call('plan_request', { goal: 'Use the configured credential.' }, 'entry-plan');
    });
    const supervisor = new ScriptedModel((messages, index) => {
      observe(messages);
      if (index === 0) return call('submit_plan', { tasks: [{ capability: 'general', objective: 'Run the credential check.' }] }, 'plan');
      if (index === 1) return call('delegate_capability', { briefing: 'Run the credential check.' }, 'delegate');
      const delivery = [...messages].reverse().find(message => ToolMessage.isInstance(message) && message.name === 'delegate_capability');
      assert.ok(delivery, 'the real capability delivery returns after resume');
      if (index === 2) return call('review_current', { completed: true, reason: 'Credential check completed.' }, 'review');
      return new AIMessage('Credential check complete.');
    });
    const subagent = new ScriptedModel((messages, index) => {
      observe(messages);
      if (index === 0) return call('run_shell', {
        command: `${process.execPath} use-credential.cjs`, timeoutSeconds: 5,
      }, 'credential-command');
      const output = messages.find(message => ToolMessage.isInstance(message) && message.name === 'run_shell');
      assert.ok(output?.text.includes('credential-used'), 'the real shell result returns to the model');
      return new AIMessage('The credential was used successfully.');
    });
    const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
    const graph = new HostGraphService();
    const threads = new Set<string>();
    // Replace only paid models; use production graph construction, registry, review,
    // stream adapter and resident admission. No manual execution-identity/ALS calls.
    const withModels = (setup: AgentChannelSetup): AgentChannelSetup => {
      threads.add(setup.input.threadId!);
      return { ...setup, graphConfig: { ...setup.graphConfig, models: { act: supervisor, answer: entry, subagent } } };
    };
    const host = await createResidentPetHost({
      petId: 'credential-pet', petName: 'Credential Pet', runtimeConfig,
      modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [{ name: 'general', description: 'Credential check.', uses: ['shell'],
        instructions: defineInstructionDocument({ content: 'Run the local credential check and report success.' }) }],
      toolkitInventory: new HostToolkitInventoryStore(inventory), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: {
        readThreadState: (setup: AgentChannelSetup) => graph.readThreadState(withModels(setup)),
        streamEvents: (setup: AgentChannelSetup, resume?: InterruptResume) => graph.streamEvents(withModels(setup), resume),
        settleAbortedRun: (setup: AgentChannelSetup) => graph.settleAbortedRun(withModels(setup)),
      } as HostGraphService,
    });
    t.after(() => host.close());
    const events: AgentServerMessage[] = [];
    host.interaction.subscribe(message => events.push(message));
    const lifecycle: string[] = [];
    host.resident.dispatch.onDispatchLifecycle(event => lifecycle.push(event.state));
    await host.resident.dispatch.dispatch({ request: 'Use the configured credential.', dispatchId: 'credential-dispatch' });
    await waitFor(() => lifecycle.includes('waiting'));
    assert.deepEqual(resolvedInstances, [], 'approval pauses before source resolution');
    await assert.rejects(access(proofPath), { code: 'ENOENT' });
    const paused = await host.interaction.snapshot();
    assert.equal(paused.type, 'session.snapshot.result');
    if (paused.type !== 'session.snapshot.result') throw Error('snapshot');
    const pending = paused.snapshot.session.pendingInterrupt;
    assert.ok(pending);
    assert.equal(pending.payload.kind, 'human_review');
    if (pending.payload.kind !== 'human_review') throw Error('human review');
    const interaction = pending.payload.interactions[0]!;
    assert.ok(interaction.options.some(option => option.id === 'approve'));
    await host.interaction.request({ type: 'interrupt.resume', requestId: 'approve-credential', interruptId: pending.interruptId,
      value: { decisions: [{ interactionId: interaction.interactionId, selectedOptionId: 'approve' }] } });
    await waitFor(() => lifecycle.includes('completed'));
    assert.deepEqual(resolvedInstances, ['credential-pet']);
    assert.equal(await readFile(proofPath, 'utf8'), createHash('sha256').update(secret).digest('hex'));
    const completed = await host.interaction.snapshot();
    for (const value of [events, paused, completed, modelMessages]) {
      assert.equal(JSON.stringify(value).includes(secret), false, 'automatic injection stays out of ordinary projections/model messages');
    }
    let checkpointCount = 0;
    for (const threadId of threads) {
      for await (const checkpoint of checkpointer.list({ configurable: { thread_id: threadId } })) {
        checkpointCount++;
        assert.equal(JSON.stringify(checkpoint).includes(secret), false, 'automatic injection stays out of checkpoint values/writes');
      }
    }
    assert.ok(checkpointCount > 0, 'checked real persisted graph checkpoints');
    await assertFilesExclude(dirname(runtimeConfig.checkpointPath), secret);
  });
