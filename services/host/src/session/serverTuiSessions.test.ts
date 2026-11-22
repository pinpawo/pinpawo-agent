import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentPlan } from '@pinpawo/agent-session';
import { createCapabilityExecutionMessage } from '@pinpawo/pet-agent/testing';
import {
  stampAgentMessageCreatedAt,
} from '@pinpawo/pet-agent';
import test from 'node:test';
import { MemorySaver } from '@langchain/langgraph';
import { setAgentMessageMetadata } from '../../../../packages/pet-agent/src/agent/messages';
import { createEmptyTuiSessionState } from './tuiSessionRegistry';
import {
  ServerTuiSessionService,
  readTuiCheckpointInputModalities,
  readTuiCheckpointMessages,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiSessionCheckpointer,
} from './serverTuiSessions';
import { createLocalChatHumanMessage } from '../agent/chatMessageInput';
import { createChatHostDepsStore, type ServerDeps } from '../serverTypes';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import {
  createTestModelProfiles,
  createTestModelServerDeps,
} from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';

const TEST_MODEL_PROFILE_ID = 'test-profile';


test('ServerTuiSessionService creates sessions without deleting earlier ones', () => {
  const state = createEmptyTuiSessionState();
  let failSave = false;
  const service = new ServerTuiSessionService({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {
      if (failSave) throw new Error('session store unavailable');
    },
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });

  const first = service.getActiveSession('pet-a');
  const second = service.createNewSession('pet-a');
  assert.equal(service.getChatThreadId('pet-a'), second.threadId);
  assert.ok(state.sessions[first.id]);

  failSave = true;
  assert.throws(() => service.createNewSession('pet-a'), /session store unavailable/);
  assert.equal(state.activeSessionIds['pet-a'], second.id);
  assert.deepEqual(Object.keys(state.sessions).sort(), [first.id, second.id].sort());
});

test('ServerTuiSessionService rolls back a model selection when persistence fails', () => {
  const state = createEmptyTuiSessionState();
  let failSave = false;
  const service = new ServerTuiSessionService({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {
      if (failSave) {
        throw new Error('session store unavailable');
      }
    },
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const session = service.getActiveSession('pet-a');
  failSave = true;

  assert.throws(
    () => service.selectModelProfile('pet-a', session.id, 'secondary'),
    /session store unavailable/,
  );
  assert.equal(state.sessions[session.id], session);
  assert.equal(
    state.sessions[session.id]?.modelProfileId,
    TEST_MODEL_PROFILE_ID,
  );
});

test('ServerTuiSessionService resumes with one save and rolls back when it fails', async () => {
  const state = createEmptyTuiSessionState();
  let saves = 0;
  let failSave = false;
  const service = new ServerTuiSessionService({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {
      saves += 1;
      if (failSave) throw new Error('session store unavailable');
    },
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const first = service.getActiveSession('pet-a');
  const second = service.createNewSession('pet-a');
  const deps = { petId: 'pet-a' } as ServerDeps;
  service.readSessionCheckpointPoint = async (_deps, session) => ({
    sessionId: session.id,
    modelProfileId: session.modelProfileId,
    requiredInputModalities: [],
    messages: [{ id: 'm-1', role: 'user', text: 'Resumed title' }],
    sessionTokenUsage: null,
    pendingInterrupt: null,
    currentPlan: null,
  });

  failSave = true;
  const before = saves;
  await assert.rejects(service.resumeSession(deps, first.id), /session store unavailable/);
  assert.equal(saves - before, 1);
  assert.equal(state.activeSessionIds['pet-a'], second.id);
  assert.equal(state.sessions[first.id], first);

  failSave = false;
  const resumedSaves = saves;
  const resumed = await service.resumeSession(deps, first.id);
  assert.equal(saves - resumedSaves, 1);
  assert.equal(state.activeSessionIds['pet-a'], first.id);
  assert.equal(resumed.session.id, first.id);
  assert.equal(state.sessions[first.id]?.title, 'Resumed title');
});

test('ServerTuiSessionService rolls back image requirements when persistence fails', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-image-ledger-save-'));
  const imagePath = join(root, 'image.png');
  await fs.writeFile(imagePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('ledger-save'),
  ]));
  const state = createEmptyTuiSessionState();
  let failSave = false;
  const service = new ServerTuiSessionService({
    state,
    saveState: () => {
      if (failSave) {
        throw new Error('session store unavailable');
      }
    },
    runtimeConfig: buildHostRuntimeConfig(root),
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const session = service.getActiveSession('pet-a');
  failSave = true;

  try {
    await assert.rejects(
      () => service.createUserMessage({
        petId: 'pet-a',
        ...createTestModelServerDeps({
          inputModalities: ['text', 'image'],
        }),
      } as never, 'describe this image', [{
        id: 'image-1',
        source: 'local-path',
        kind: 'file',
        path: imagePath,
        name: 'image.png',
      }]),
      /session store unavailable/,
    );
    assert.equal(state.sessions[session.id], session);
    assert.deepEqual(
      state.sessions[session.id]?.requiredInputModalities,
      ['text'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ServerTuiSessionService injects active session createdAt into runtime environment', () => {
  const state = createEmptyTuiSessionState();
  const service = new ServerTuiSessionService({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const session = service.getActiveSession('pet-a');
  const setup = service.buildChatSetup({
    petId: 'pet-a',
    ...createTestModelServerDeps(),
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-tui-workdir'),
  } as never, {
    pet: {
      id: 'pet-a',
      name: 'Paw',
    },
  });

  assert.ok(setup.input.context?.systemPromptSections?.some(({ content }) => content.includes(session.createdAt)));
  assert.equal(setup.input.context?.workdir, '/tmp/pinpawo-tui-workdir');
});

test('runtime config updates reach the next chat setup through the normalized deps store', () => {
  const service = new ServerTuiSessionService({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    state: createEmptyTuiSessionState(),
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const runtimeDeps = createChatHostDepsStore({
    petId: 'pet-a',
    modelProfiles: createTestModelProfiles(),
    toolAuthorizationMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-policy-update'),
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityCatalog: createTestModelServerDeps().capabilityCatalog,
  });
  const context = {
    pet: {
      id: 'pet-a',
      name: 'Paw',
    },
  };

  const beforeDeps = runtimeDeps.get();
  const before = service.buildChatSetup(beforeDeps, context);
  runtimeDeps.updateToolAuthorizationMode('auto_authorization', 'strict');
  const afterDeps = runtimeDeps.get();
  const after = service.buildChatSetup(afterDeps, context);

  assert.notEqual(afterDeps, beforeDeps);
  assert.equal(Object.isFrozen(afterDeps), true);
  assert.equal(Object.isFrozen(afterDeps.modelProfiles), true);
  assert.equal(before.input.globalReviewPolicy?.mode, 'require_authorization');
  assert.equal(after.input.globalReviewPolicy?.mode, 'auto_authorization');
});

test('ServerTuiSessionService reads one checkpoint point for messages and pending review', async () => {
  const state = createEmptyTuiSessionState();
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' as const } }],
  };
  let capturedThreadId: string | undefined;
  let readCount = 0;
  const checkpointer = {
    deleteThread: async () => {},
  } as unknown as TuiSessionCheckpointer;
  const service = new ServerTuiSessionService({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {},
    checkpointer,
    graphService: {
      readThreadState: async (setup: { input: { threadId?: string } }) => {
        readCount += 1;
        capturedThreadId = setup.input.threadId;
        return {
          messages: [new HumanMessage('checkpoint prompt')],
          pendingInterrupt: { interruptId: 'interrupt-1', payload: { kind: 'human_review', reviews: [review] } },
        acceptsResume: true,
        };
      },
    } as never,
    loadContext: async () => ({
      pet: {
        id: 'pet-a',
        name: 'Paw',
      },
    }),
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });

  const session = service.getActiveSession('pet-a');
  const checkpoint = await service.readActiveCheckpointPoint({
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-session-test'),
    petId: 'pet-a',
    ...createTestModelServerDeps(),
  } as never);

  assert.deepEqual(checkpoint.pendingInterrupt, {
    sessionId: session.id,
    interruptId: 'interrupt-1',
    payload: { kind: 'human_review', reviews: [review] },
  });
  assert.deepEqual(checkpoint.messages, [{ role: 'user', text: 'checkpoint prompt' }]);
  assert.equal(checkpoint.sessionTokenUsage, null);
  assert.equal(capturedThreadId, session.threadId);
  assert.equal(readCount, 1);
});

async function readCheckpoint(messages: BaseMessage[], currentPlan: AgentPlan | null, includeLatestDelivery?: true) {
  const runtimeConfig = buildHostRuntimeConfig('/tmp/pinpawo-session-progress-test');
  const service = new ServerTuiSessionService({
    runtimeConfig,
    state: createEmptyTuiSessionState(),
    saveState: () => {},
    checkpointer: new MemorySaver(),
    graphService: { readThreadState: async () => ({ messages, currentPlan, pendingInterrupt: null, acceptsResume: false }) },
    loadContext: async () => ({ pet: { id: 'pet-a', name: 'Paw' } }),
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const deps = { runtimeConfig, petId: 'pet-a', ...createTestModelServerDeps() };
  return service.readSessionCheckpointPoint(deps, service.getActiveSession('pet-a'), includeLatestDelivery);
}

const receiptScope = { runId: 'current', taskId: 'current-task' };
const olderReceipt = { runId: 'older', taskId: 'older-task' };

function returnedCapability(n: string, text: string, identity = receiptScope, privateLane?: string) {
  const metadata = { ...identity, lane: privateLane };
  const callId = `call:${n}`;
  const tool = new AIMessage({ content: '', additional_kwargs: { pinpawo: metadata },
    tool_calls: [{ id: callId, name: 'delegate_capability', args: { briefing: 'PRIVATE_BRIEFING' } }] });
  return [tool, createCapabilityExecutionMessage({ callId, metadata,
    execution: { planItemId: n, capability: 'general', task: 'PRIVATE_TITLE', delegationId: n, briefing: 'PRIVATE_BRIEFING' },
    result: { status: 'returned', deliverables: [{ uri: 'artifact://private/x' }],
      delivery: { id: n, task: 'PRIVATE_TITLE', text, scope: { ...identity, lane: 'capability:general', delegationId: n } } },
  })];
}

const recordedPlan = (...items: Array<[AgentPlan['items'][number]['status'], string]>): AgentPlan => ({
  items: items.map(([status, task], index) => ({ id: String(index), capability: 'general', task, status })),
});

test('latest formal root delivery and recorded plan are distinct Session evidence', async () => {
  const messages = [...returnedCapability('0', 'Previous delivery', olderReceipt), ...returnedCapability('1', 'Earlier finding.'),
    ...returnedCapability('2', 'A verified; two sources agree.\n```json\n{"raw":"no"}\n```'),
    ...returnedCapability('3', 'Nested result', receiptScope, 'capability:general'),
    new ToolMessage({ name: 'not_a_handoff', tool_call_id: '4', content: 'RAW TOOL OUTPUT' })];
  const plan = recordedPlan(['completed', 'A'], ['active', 'Verify B']);
  const ordinary = await readCheckpoint(messages, plan);
  const optedIn = await readCheckpoint(messages, plan, true);
  assert.equal(ordinary.latestDelivery, undefined);
  assert.ok(optedIn.latestDelivery?.startsWith('A verified; two sources agree.'));
  assert.deepEqual(optedIn.currentPlan, ordinary.currentPlan);
  assert.deepEqual(optedIn.currentPlan, plan);
  assert.deepEqual(optedIn.messages, ordinary.messages);
});

test('uses the Session’s previous Root delivery until the Session records a newer one', async () => {
  const previous = returnedCapability('1', 'Previous delivery', olderReceipt);
  const previousPlan = recordedPlan(['pending', 'Previous objective']);
  const checkpoint = await readCheckpoint(previous, previousPlan, true);
  assert.equal(checkpoint.latestDelivery, 'Previous delivery');
  assert.deepEqual(checkpoint.currentPlan, previousPlan);
  const requested = new AIMessage({ content: '', additional_kwargs: { pinpawo: receiptScope },
    tool_calls: [{ id: 'unreturned', name: 'delegate_capability', args: { briefing: 'NOT RETURNED' } }] });
  assert.equal((await readCheckpoint([...previous, requested], null, true)).latestDelivery, 'Previous delivery');
  assert.equal((await readCheckpoint([...previous, ...returnedCapability('2', 'New delivery')], null, true)).latestDelivery, 'New delivery');
});

test('no delivery is selected when only the recorded plan exists', async () => {
  const plan = recordedPlan(['pending', 'Check B']);
  const checkpoint = await readCheckpoint([], plan, true);
  assert.equal(checkpoint.latestDelivery, undefined);
  assert.deepEqual(checkpoint.currentPlan, plan);
});

test('reserved dispatch sessions retry failed persistence without changing the active TUI session', () => {
  const state = createEmptyTuiSessionState();
  let fail = false;
  const service = new ServerTuiSessionService({ state, runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-reserved-test'),
    saveState: () => { if (fail) throw Error('disk unavailable'); },
    checkpointer: new MemorySaver(),
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const active = service.getActiveSession('pet-a');
  const id = 'pet-a:12345678';
  fail = true;
  assert.throws(() => service.ensureDispatchSession('pet-a', id, true), /disk/);
  assert.equal(state.sessions[id], undefined);
  fail = false;
  const reserved = service.ensureDispatchSession('pet-a', id, true);
  assert.equal(service.ensureDispatchSession('pet-a', id, true), reserved);
  assert.equal(service.getActiveSessionId('pet-a'), active.id);
  assert.throws(() => service.ensureDispatchSession('pet-b', id), /another Pet/);
  delete state.sessions[id];
  assert.throws(() => service.ensureDispatchSession('pet-a', id), /no longer exists/);
});
