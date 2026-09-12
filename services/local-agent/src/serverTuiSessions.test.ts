import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  stampAgentMessageCreatedAt,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import test from 'node:test';
import { setAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages';
import { createEmptyTuiSessionState } from './tuiSessionRegistry';
import {
  ServerTuiSessionService,
  readTuiCheckpointInputModalities,
  readTuiCheckpointMessages,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiSessionCheckpointer,
} from './serverTuiSessions';
import { createLocalChatHumanMessage } from './agent/chatMessageInput';
import { createLocalServerRuntimeDepsStore, type ServerDeps } from './serverTypes';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import {
  createTestModelProfiles,
  createTestModelServerDeps,
} from './testing/modelProfiles';
import { HostToolkitInventoryStore } from './toolkits/toolkitInventory';

const TEST_MODEL_PROFILE_ID = 'test-profile';

const testArtifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => {
    throw new Error('not implemented in this test');
  },
  readArtifact: async () => {
    throw new Error('not implemented in this test');
  },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};


test('ServerTuiSessionService creates and resets active sessions', async () => {
  const state = createEmptyTuiSessionState();
  const saved: number[] = [];
  const deletedThreads: string[] = [];
  const checkpointer = {
    deleteThread: async (threadId: string) => {
      deletedThreads.push(threadId);
    },
  } as TuiSessionCheckpointer;
  const service = new ServerTuiSessionService({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {
      saved.push(1);
    },
    checkpointer,
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });

  const first = service.getActiveSession('pet-a');
  const second = service.createNewSession('pet-a');
  const third = await service.resetSession('pet-a', {
    deletePrevious: true,
  });

  assert.equal(service.getChatThreadId('pet-a'), third.threadId);
  assert.equal(state.sessions[first.id] !== undefined, true);
  assert.equal(state.sessions[second.id], undefined);
  assert.deepEqual(deletedThreads, [second.threadId]);
  assert.equal(saved.length >= 4, true);
});

test('ServerTuiSessionService rolls back a model selection when persistence fails', () => {
  const state = createEmptyTuiSessionState();
  let failSave = false;
  const service = new ServerTuiSessionService({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-session-test'),
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
    runtimeConfig: buildLocalAgentRuntimeConfig(root),
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
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-session-test'),
    state,
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const session = service.getActiveSession('pet-a');
  const setup = service.buildChatSetup({
    petId: 'pet-a',
    ...createTestModelServerDeps(),
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-tui-workdir'),
    capabilityArtifactStore: testArtifactStore,
  } as never, {
    pet: {
      id: 'pet-a',
      name: 'Paw',
    },
  });

  assert.ok(setup.input.context?.systemPromptSections?.some(({ content }) => content.includes(session.createdAt)));
  assert.equal(setup.input.context?.workdir, '/tmp/pinpawo-tui-workdir');
});

test('chat setup requires an artifact store at the type boundary', () => {
  // This used to be a runtime throw. ServerDeps now declares
  // capabilityArtifactStore required, so a Host that forgets one does not
  // compile — the check moved from a thrown Error to the contract, which
  // catches it earlier and cannot be reached in production anyway.
  const deps = {
    serverMode: 'chat' as const,
    petId: 'pet-a',
    ...createTestModelServerDeps(),
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-artifact-store'),
  };
  assert.ok(deps.capabilityArtifactStore, 'the contract supplies a store');

  // @ts-expect-error capabilityArtifactStore is required by ServerDeps.
  const missing: ServerDeps = { ...deps, capabilityArtifactStore: undefined };
  assert.equal(missing.capabilityArtifactStore, undefined);
});

test('runtime config updates reach the next chat setup through the normalized deps store', () => {
  const service = new ServerTuiSessionService({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-session-test'),
    state: createEmptyTuiSessionState(),
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const runtimeDeps = createLocalServerRuntimeDepsStore({
    serverMode: 'chat',
    petId: 'pet-a',
    modelProfiles: createTestModelProfiles(),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-policy-update'),
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: testArtifactStore,
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
  runtimeDeps.updateReviewPolicy('auto_authorization', 'strict');
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
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-session-test'),
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
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-session-test'),
    petId: 'pet-a',
    ...createTestModelServerDeps(),
    capabilityArtifactStore: testArtifactStore,
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
