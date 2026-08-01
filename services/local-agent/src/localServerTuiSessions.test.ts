import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  stampMessageCreatedAtUtc,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import test from 'node:test';
import { createEmptyTuiSessionState } from './tuiSessionRegistry';
import {
  LocalServerTuiSessionService,
  readTuiCheckpointMessages,
  readTuiCheckpointTokenUsage,
  summarizeTuiCheckpointMessages,
  type TuiSessionCheckpointer,
} from './localServerTuiSessions';
import { createLocalChatHumanMessage } from './localChatAttachments';
import { createLocalServerRuntimeDepsStore } from './localServerTypes';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import {
  createTestModelProfiles,
  createTestModelServerDeps,
} from './testing/modelProfiles';

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

test('readTuiCheckpointMessages keeps visible conversation and handoff messages', () => {
  const userMessage = stampMessageCreatedAtUtc(
    new HumanMessage(' hello '),
    '2026-06-01T01:00:00.000Z',
  );
  const assistantMessage = stampMessageCreatedAtUtc(
    new AIMessage('assistant reply'),
    '2026-06-01T01:00:01.000Z',
  );
  const messages = readTuiCheckpointMessages([
    new SystemMessage('system'),
    userMessage,
    new AIMessage({
      content: 'subagent hidden',
      additional_kwargs: { pinpawo: { lane: 'subagent' } },
    }),
    new AIMessage({
      content: 'synthetic plan hidden',
      additional_kwargs: {
        pinpawo: {
          source: 'delegation_plan',
          synthetic: true,
        },
      },
    }),
    new AIMessage({
      content: 'malformed handoff hidden',
      additional_kwargs: {
        pinpawo: {
          handoffFrom: 'capability:general',
        },
      },
    }),
    new AIMessage({
      content: 'handoff result visible',
      additional_kwargs: {
        pinpawo: {
          handoffFrom: 'capability:general',
          delegationId: 'delegation-1',
          runId: 'run-1',
        },
      },
    }),
    assistantMessage,
  ]);

  assert.deepEqual(messages, [
    { role: 'user', text: 'hello', createdAt: '2026-06-01T01:00:00.000Z' },
    { role: 'subagent', requestId: 'run-1', text: 'handoff result visible' },
    { role: 'assistant', text: 'assistant reply', createdAt: '2026-06-01T01:00:01.000Z' },
  ]);
});

test('readTuiCheckpointMessages uses attachment display metadata instead of local paths', () => {
  const messages = readTuiCheckpointMessages([
    createLocalChatHumanMessage('review this', [{
      id: 'attachment-1',
      source: 'local-path',
      kind: 'file',
      path: '/Users/example/private/spec.md',
      name: 'spec.md',
    }]),
  ]);

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0]?.text,
    'review this\n\nAttachments:\n- file: spec.md',
  );
  assert.doesNotMatch(messages[0]?.text ?? '', /Users\/example/);
});

test('readTuiCheckpointTokenUsage aggregates every provider call in the session', () => {
  const usage = readTuiCheckpointTokenUsage([
    new HumanMessage('hello'),
    new AIMessage({
      content: '',
      usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }),
    new AIMessage({
      content: 'answer',
      usage_metadata: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
    }),
    new AIMessage({
      content: 'hidden lane',
      additional_kwargs: { pinpawo: { lane: 'subagent' } },
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    }),
  ]);

  assert.deepEqual(usage, {
    inputTokens: 125,
    outputTokens: 55,
    totalTokens: 180,
    latestInputTokens: 100,
    source: 'provider',
    scope: 'session',
  });
});

test('summarizeTuiCheckpointMessages derives title from first user message', () => {
  const summary = summarizeTuiCheckpointMessages([
    { role: 'assistant', text: '先回答' },
    { role: 'user', text: '  标题   带   空格  ' },
  ], '2026-06-02T00:00:00.000Z');

  assert.deepEqual(summary, {
    title: '标题 带 空格',
    messageCount: 2,
    updatedAt: '2026-06-02T00:00:00.000Z',
  });
  assert.equal(summarizeTuiCheckpointMessages([], '2026-06-02T00:00:00.000Z').title, '空会话');
});

test('LocalServerTuiSessionService creates and resets active sessions', async () => {
  const state = createEmptyTuiSessionState();
  const saved: number[] = [];
  const deletedThreads: string[] = [];
  const checkpointer = {
    deleteThread: async (threadId: string) => {
      deletedThreads.push(threadId);
    },
  } as TuiSessionCheckpointer;
  const service = new LocalServerTuiSessionService({
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

test('LocalServerTuiSessionService rolls back a model selection when persistence fails', () => {
  const state = createEmptyTuiSessionState();
  let failSave = false;
  const service = new LocalServerTuiSessionService({
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

test('LocalServerTuiSessionService rolls back image requirements when persistence fails', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-image-ledger-save-'));
  const imagePath = join(root, 'image.png');
  await fs.writeFile(imagePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('ledger-save'),
  ]));
  const state = createEmptyTuiSessionState();
  let failSave = false;
  const service = new LocalServerTuiSessionService({
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
        actorId: 'pet-a',
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

test('LocalServerTuiSessionService injects active session createdAt into runtime environment', () => {
  const state = createEmptyTuiSessionState();
  const service = new LocalServerTuiSessionService({
    state,
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const session = service.getActiveSession('pet-a');
  const setup = service.buildChatSetup({
    actorId: 'pet-a',
    ...createTestModelServerDeps(),
    workdir: '/tmp/pinpawo-tui-workdir',
    capabilityArtifactStore: testArtifactStore,
  } as never, {
    pet: {
      id: 'pet-a',
      name: 'Paw',
      personality: null,
      species: null,
      stage: null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      recentDaily: [],
      trendItems: [],
      today: '2026-06-11',
    },
  });

  assert.match(setup.input.runtimeEnvironment ?? '', new RegExp(`会话开始时间：${session.createdAt}`));
  assert.match(setup.input.runtimeEnvironment ?? '', /时区：/);
  assert.match(setup.input.runtimeEnvironment ?? '', /工作目录：\/tmp\/pinpawo-tui-workdir/);
  assert.doesNotMatch(setup.input.runtimeEnvironment ?? '', /进程 cwd/);
});

test('LocalServerTuiSessionService rejects chat setup without a thread-scoped artifact store', () => {
  const service = new LocalServerTuiSessionService({
    state: createEmptyTuiSessionState(),
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });

  assert.throws(
    () => service.buildChatSetup({
      actorId: 'pet-a',
      ...createTestModelServerDeps(),
      workdir: '/tmp/pinpawo-missing-artifact-store',
    }, {
      pet: {
        id: 'pet-a',
        name: 'Paw',
        personality: null,
        species: null,
        stage: null,
        growth_value: null,
        stage_asset_id: null,
      },
      context: {
        petMemoryText: '',
        recentChatTurns: [],
        recentDaily: [],
        trendItems: [],
        today: '2026-06-11',
      },
    }),
    /requires a capability artifact store/,
  );
});

test('runtime config updates reach the next chat setup through the normalized deps store', () => {
  const service = new LocalServerTuiSessionService({
    state: createEmptyTuiSessionState(),
    saveState: () => {},
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });
  const runtimeDeps = createLocalServerRuntimeDepsStore({
    actorId: 'pet-a',
    modelProfiles: createTestModelProfiles({
      globalReviewPolicyMode: 'require_authorization',
    }),
    globalReviewPolicyMode: 'require_authorization',
    workdir: '/tmp/pinpawo-policy-update',
    capabilityArtifactStore: testArtifactStore,
  });
  const context = {
    pet: {
      id: 'pet-a',
      name: 'Paw',
      personality: null,
      species: null,
      stage: null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      recentDaily: [],
      trendItems: [],
      today: '2026-06-11',
    },
  };

  const beforeDeps = runtimeDeps.get();
  const before = service.buildChatSetup(beforeDeps, context);
  runtimeDeps.updateGlobalReviewPolicyMode('auto_authorization');
  const afterDeps = runtimeDeps.get();
  const after = service.buildChatSetup(afterDeps, context);

  assert.notEqual(afterDeps, beforeDeps);
  assert.equal(Object.isFrozen(afterDeps), true);
  assert.equal(Object.isFrozen(afterDeps.modelProfiles), true);
  assert.equal(before.input.globalReviewPolicy?.mode, 'require_authorization');
  assert.equal(after.input.globalReviewPolicy?.mode, 'auto_authorization');
});

test('LocalServerTuiSessionService reads one checkpoint point for messages and pending review', async () => {
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
  const service = new LocalServerTuiSessionService({
    state,
    saveState: () => {},
    checkpointer,
    graphService: {
      readThreadState: async (setup: { input: { threadId?: string } }) => {
        readCount += 1;
        capturedThreadId = setup.input.threadId;
        return {
          messages: [new HumanMessage('checkpoint prompt')],
          pendingHumanReview: { review },
          hasPendingContinuation: true,
        };
      },
    } as never,
    loadContext: async () => ({
      pet: {
        id: 'pet-a',
        name: 'Paw',
        personality: null,
        species: null,
        stage: null,
        growth_value: null,
        stage_asset_id: null,
      },
      context: {
        petMemoryText: '',
        recentChatTurns: [],
        recentDaily: [],
        trendItems: [],
        today: '2026-06-11',
      },
    }),
    defaultModelProfileId: TEST_MODEL_PROFILE_ID,
  });

  const session = service.getActiveSession('pet-a');
  const checkpoint = await service.readActiveCheckpointPoint({
    actorId: 'pet-a',
    ...createTestModelServerDeps(),
    capabilityArtifactStore: testArtifactStore,
  } as never);

  assert.deepEqual(checkpoint.pendingReview, {
    sessionId: session.id,
    review,
  });
  assert.deepEqual(checkpoint.messages, [{ role: 'user', text: 'checkpoint prompt' }]);
  assert.equal(checkpoint.sessionTokenUsage, null);
  assert.equal(capturedThreadId, session.threadId);
  assert.equal(readCount, 1);
});
