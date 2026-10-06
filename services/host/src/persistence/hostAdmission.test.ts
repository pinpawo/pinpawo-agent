import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryHostPersistence } from './memoryHostPersistence';
import { createResidentPetHost } from '../residentPetHost';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { createTestModelProfiles } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import { FileSaver } from '../fileSaver';

test('Host does not queue or execute if durable invocation admission fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-failure-'));
  let fail = false, executed = 0;
  const persistence = createMemoryHostPersistence({ defaultModelProfileId: 'test-profile', commit: async state => {
    if (fail && Object.keys(state.invocations).length) throw new Error('admission disk failure');
  } });
  const config = buildHostRuntimeConfig(root);
  const host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
    modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer: new FileSaver(config.checkpointPath),
    sessionStatePath: config.tuiSessionPath, persistence,
    capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); }, listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
    graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }) } as never,
    runAgentTurn: async () => { executed++; return { status: 'completed', reply: 'done' }; },
  });
  try {
    fail = true;
    await assert.rejects(host.resident.dispatch.dispatch({ dispatchId: 'rejected', request: 'never run' }), /admission disk failure/);
    assert.equal((await persistence.invocations.read('rejected')), null);
    assert.equal(host.resident.dispatch.getQueueSnapshot().queuedDispatches, 0);
    assert.equal(executed, 0);
    fail = false;
    await host.resident.dispatch.dispatch({ dispatchId: 'accepted', request: 'run once', idempotencyKey: 'same' });
    await host.resident.dispatch.dispatch({ dispatchId: 'retry', request: 'run once', idempotencyKey: 'same' });
    for (let attempt = 0; attempt < 100 && (Number(executed) !== 1 || host.resident.dispatch.getQueueSnapshot().state !== 'open'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(executed, 1);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { entered, enter, pending, release };
}
async function waitFor(done: () => boolean) {
  for (let i = 0; i < 200; i++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out');
}
const unusedArtifacts = {
  writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
  listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async (uri: string) => uri,
};

test('delayed durable admission, start, identity and settlement each hold the next boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-delayed-commit-'));
  const gates = { admission: barrier(), start: barrier(), identity: barrier(), settlement: barrier() };
  const visited = new Set<string>();
  let effects = 0, accepted = false;
  const published: string[] = [];
  const persistence = createMemoryHostPersistence({ defaultModelProfileId: 'test-profile', commit: async state => {
    const record = state.invocations['delayed'];
    if (!record) return;
    const phase = record.state === 'queued' ? 'admission' : record.state === 'completed' ? 'settlement'
      : record.runtime ? 'identity' : 'start';
    if (visited.has(phase)) return;
    visited.add(phase); gates[phase].enter(); await gates[phase].pending;
  } });
  const config = buildHostRuntimeConfig(root);
  const host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
    modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer: new FileSaver(config.checkpointPath),
    sessionStatePath: config.tuiSessionPath, persistence, capabilityArtifactStore: unusedArtifacts,
    graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }) } as never,
    runAgentTurn: async options => {
      assert.ok(options.onExecutionIdentity);
      await options.onExecutionIdentity({ threadId: options.setup.input.threadId!, taskId: 'task', runId: 'run' });
      effects++;
      return { status: 'completed', reply: 'done' };
    },
  });
  const stop = host.resident.dispatch.onDispatchLifecycle(event => published.push(event.state));
  const dispatch = host.resident.dispatch.dispatch({ dispatchId: 'delayed', request: 'once' }).then(receipt => { accepted = true; return receipt; });
  try {
    await gates.admission.entered;
    assert.equal(accepted, false);
    assert.equal(host.resident.dispatch.getQueueSnapshot().queuedDispatches, 0);
    assert.deepEqual(published, []); assert.equal(effects, 0);
    gates.admission.release();
    await gates.start.entered;
    await dispatch;
    assert.equal(accepted, true);
    assert.deepEqual(published, ['queued']); assert.equal(effects, 0);
    gates.start.release();
    await gates.identity.entered;
    assert.deepEqual(published, ['queued', 'running']); assert.equal(effects, 0);
    gates.identity.release();
    await gates.settlement.entered;
    assert.equal(effects, 1); assert.deepEqual(published, ['queued', 'running']);
    gates.settlement.release();
    await waitFor(() => published.some(state => state === 'completed'));
    assert.deepEqual(published, ['queued', 'running', 'completed']);
    const record = await persistence.invocations.read('delayed');
    assert.equal(record?.reply, 'done'); assert.equal(record?.runtime?.runId, 'run');
  } finally {
    for (const gate of Object.values(gates)) gate.release();
    await dispatch.catch(() => {}); stop(); await host.close(); await rm(root, { recursive: true, force: true });
  }
});

test('injected configuration owns policy reads/writes and durable failure does not update live policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-injected-config-'));
  const { hostConfiguration } = await import('./configuration');
  const originalRead = hostConfiguration.readConfiguration, originalWrite = hostConfiguration.replaceConfiguration;
  const gate = barrier();
  let configuration = { workdir: '/injected', global_review_policy: 'require_authorization' };
  let fail = false, reads = 0, writes = 0;
  const modes: unknown[] = [], replies: Array<{ type: string; requestId?: string }> = [];
  const persistence = createMemoryHostPersistence({ defaultModelProfileId: 'test-profile', configuration: {
    readConfiguration: async () => { reads++; return { ...configuration }; },
    replaceConfiguration: async value => {
      writes++; if (fail) throw new Error('selected backend rejected write');
      gate.enter(); await gate.pending; configuration = value as typeof configuration;
    },
  } });
  hostConfiguration.readConfiguration = async () => { throw new Error('unexpected default configuration read'); };
  hostConfiguration.replaceConfiguration = async () => { throw new Error('unexpected default configuration write'); };
  const config = buildHostRuntimeConfig(root);
  let host: Awaited<ReturnType<typeof createResidentPetHost>> | undefined;
  try {
    host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
      modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer: new FileSaver(config.checkpointPath),
      sessionStatePath: config.tuiSessionPath, persistence, capabilityArtifactStore: unusedArtifacts,
      graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }) } as never,
      runAgentTurn: async ({ setup }) => { modes.push(setup.input.globalReviewPolicy?.mode); return { status: 'completed', reply: 'done' }; },
    });
    const connection = { isConnected: () => true, send: (message: { type: string; requestId?: string }) => { replies.push(message); return true; } };
    host.interaction.connect(connection);
    const request = host.interaction.handle(connection, { type: 'runtime_config.update', requestId: 'policy', globalReviewPolicyMode: 'auto_authorization', autoAuthorizationSafetyLevel: 'strict' });
    await gate.entered;
    assert.equal(replies.some(message => message.type === 'runtime_config.result'), false);
    gate.release(); await request;
    assert.equal(configuration.workdir, '/injected'); assert.equal(configuration.global_review_policy, 'auto_authorization');
    fail = true;
    await host.interaction.handle(connection, { type: 'runtime_config.update', requestId: 'failure', globalReviewPolicyMode: 'full_access', autoAuthorizationSafetyLevel: 'relaxed' });
    assert.ok(replies.some(message => message.type === 'runtime_config.error' && message.requestId === 'failure'));
    assert.equal(reads, 2); assert.equal(writes, 2);
    await host.resident.dispatch.dispatch({ request: 'check live policy' });
    await waitFor(() => modes.length === 1 && host!.resident.dispatch.getQueueSnapshot().state === 'open');
    assert.deepEqual(modes, ['auto_authorization']);
  } finally {
    gate.release(); await host?.close(); hostConfiguration.readConfiguration = originalRead; hostConfiguration.replaceConfiguration = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test('a completed runtime with a failed result commit remains recoverable without a false failure or reexecution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-result-commit-failure-'));
  let failResult = true, effects = 0;
  let runtime: { threadId: string; taskId: string; runId: string } | undefined;
  const events: string[] = [];
  const persistence = createMemoryHostPersistence({ defaultModelProfileId: 'test-profile', commit: async state => {
    if (failResult && state.invocations['result']?.state === 'completed') throw new Error('result commit unavailable');
  } });
  const config = buildHostRuntimeConfig(root);
  const options = { petId: 'pet', petName: 'Pet', runtimeConfig: config,
    modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization' as const, autoAuthorizationSafetyLevel: 'strict' as const,
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer: new FileSaver(config.checkpointPath),
    sessionStatePath: config.tuiSessionPath, persistence, capabilityArtifactStore: unusedArtifacts,
    graphService: {
      readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }),
      readExecutionDescriptor: async () => ({ identity: runtime, state: 'completed', reply: 'done' }),
    } as never,
    runAgentTurn: async (turn: import('../agent/chatSessionAdapter').AgentSessionTurnOptions) => {
      runtime = { threadId: turn.setup.input.threadId!, taskId: 'task', runId: 'run' };
      await turn.onExecutionIdentity!(runtime); effects++;
      return { status: 'completed' as const, reply: 'done' };
    },
  };
  let host = await createResidentPetHost(options);
  let stop = host.resident.dispatch.onDispatchLifecycle(event => events.push(event.state));
  try {
    await host.resident.dispatch.dispatch({ dispatchId: 'result', request: 'once' });
    await waitFor(() => effects === 1 && host.resident.dispatch.getQueueSnapshot().state === 'open');
    assert.deepEqual(events, ['queued', 'running']);
    assert.equal((await persistence.invocations.read('result'))?.state, 'running');
    stop(); await host.close(); failResult = false;
    host = await createResidentPetHost(options);
    stop = host.resident.dispatch.onDispatchLifecycle(event => events.push(event.state));
    await host.resident.dispatch.replayDispatchLifecycle!();
    assert.deepEqual(events, ['queued', 'running', 'completed']);
    assert.equal((await persistence.invocations.read('result'))?.reply, 'done');
    assert.equal(effects, 1);
  } finally { stop(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
