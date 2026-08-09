import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BaseMessage } from '@langchain/core/messages';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import type { LocalAgentGraphService } from './agentGraphService';
import { createLocalServerHandlers } from './localServerHandlers';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import type { LocalServerPeer } from './localServerPeer';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import {
  createTestModelProfileRegistry,
  createTestModelServerDeps,
} from './testing/modelProfiles';

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

function createPeer(sent: LocalAgentServerMessage[]): LocalServerPeer {
  return {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
}

function loadTestContext() {
  return Promise.resolve({
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
      today: '2026-07-30',
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('session.new returns an authoritative empty snapshot for a unique session', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-session-new-'));
  const sent: LocalAgentServerMessage[] = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps(),
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-1',
    });
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-2',
    });

    assert.equal(sent.length, 2);
    const first = sent[0];
    const second = sent[1];
    assert.equal(first?.type, 'session.new.result');
    assert.equal(second?.type, 'session.new.result');
    if (
      first?.type !== 'session.new.result'
      || second?.type !== 'session.new.result'
    ) {
      return;
    }
    assert.equal(first.requestId, 'new-1');
    assert.equal(first.session.id, first.snapshot.session.sessionId);
    assert.equal(first.snapshot.session.timeline.length, 0);
    assert.equal(first.snapshot.session.activeRun, null);
    assert.equal(first.session.active, true);
    assert.notEqual(second.session.id, first.session.id);
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('session.compact is a v2 session command and returns the authoritative snapshot', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-session-compact-'));
  const sent: LocalAgentServerMessage[] = [];
  const graphService = {
    readThreadState: async () => ({
      messages: [],
      pendingHumanReview: null,
      hasPendingContinuation: false,
      currentPlan: null,
    }),
    updateState: async () => {
      throw new Error('empty context must not be written');
    },
  } as unknown as LocalAgentGraphService;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps(),
    capabilityArtifactStore: testArtifactStore,
  }, {
    chatGraphService: graphService,
    loadContext: loadTestContext,
  });

  try {
    const peer = createPeer(sent);
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-before-compact',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;

    await handlers.peerHandlers.onSessionCompact!(peer, {
      type: 'session.compact',
      requestId: 'compact-1',
      sessionId: created.session.id,
    });
    const result = sent.find((message) => message.type === 'session.compact.result');
    assert.equal(result?.type, 'session.compact.result');
    if (result?.type !== 'session.compact.result') return;
    assert.equal(result.compacted, false);
    assert.equal(result.snapshot.session.timeline.length, 0);

    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-after-compact',
    });
    await handlers.peerHandlers.onSessionCompact!(peer, {
      type: 'session.compact',
      requestId: 'compact-stale-session',
      sessionId: created.session.id,
    });
    const stale = sent.find((message) => (
      message.type === 'session.error'
      && message.requestId === 'compact-stale-session'
    ));
    assert.equal(stale?.type, 'session.error');
    if (stale?.type === 'session.error') {
      assert.equal(stale.operation, 'compact');
      assert.match(stale.message, /active session/);
    }
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('model protocol lists sanitized profiles and persists an acknowledged session selection', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-select-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  const modelProfiles = createTestModelProfileRegistry([
    {
      modelProfileId: 'primary',
      label: 'Primary',
      apiKey: 'primary-super-secret',
      baseUrl: 'https://primary.example.test/private/v1?tenant=one',
      model: 'same-model',
      contextWindowTokens: 32_000,
    },
    {
      modelProfileId: 'secondary',
      label: 'Secondary',
      apiKey: 'secondary-super-secret',
      baseUrl: 'https://secondary.example.test/private/v1?tenant=two',
      model: 'same-model',
      contextWindowTokens: 64_000,
      inputModalities: ['text', 'image'],
    },
  ], 'primary');
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles,
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-model-session',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;
    const sessionId = created.session.id;
    assert.equal(
      created.snapshot.session.runtime?.modelProfileId,
      'primary',
    );

    await handlers.peerHandlers.onModelList(peer, {
      type: 'model.list',
      requestId: 'list-models',
      sessionId,
    });
    const listed = sent.find((message) => message.type === 'model.list.result');
    assert.equal(listed?.type, 'model.list.result');
    if (listed?.type !== 'model.list.result') return;
    assert.equal(listed.defaultProfileId, 'primary');
    assert.equal(listed.selectedProfileId, 'primary');
    assert.deepEqual(listed.profiles.map((profile) => ({
      id: profile.id,
      endpointHost: profile.endpointHost,
      inputModalities: profile.inputModalities,
    })), [
      {
        id: 'primary',
        endpointHost: 'primary.example.test',
        inputModalities: ['text'],
      },
      {
        id: 'secondary',
        endpointHost: 'secondary.example.test',
        inputModalities: ['text', 'image'],
      },
    ]);
    const projected = JSON.stringify(listed);
    assert.doesNotMatch(projected, /super-secret|private\/v1|tenant=/);

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-unknown',
      sessionId,
      modelProfileId: 'unknown',
    });
    const unavailable = sent.find((message) => (
      message.type === 'model.select.error'
      && message.requestId === 'select-unknown'
    ));
    assert.equal(unavailable?.type, 'model.select.error');
    if (unavailable?.type !== 'model.select.error') return;
    assert.equal(unavailable.code, 'profile_unavailable');

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-secondary',
      sessionId,
      modelProfileId: 'secondary',
    });
    const selected = sent.find((message) => (
      message.type === 'model.select.result'
    ));
    assert.equal(selected?.type, 'model.select.result');
    if (selected?.type !== 'model.select.result') return;
    assert.equal(selected.selectedProfileId, 'secondary');
    assert.equal(
      selected.snapshot.session.runtime?.modelProfileId,
      'secondary',
    );
    assert.equal(
      selected.snapshot.session.runtime?.contextWindow,
      64_000,
    );

    const persisted = JSON.parse(
      readFileSync(runtimeConfig.tuiSessionPath, 'utf8'),
    ) as {
      sessions: Record<string, { modelProfileId?: string }>;
    };
    assert.equal(
      persisted.sessions[sessionId]?.modelProfileId,
      'secondary',
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('model selection keeps the previous profile when checkpoint preparation fails', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-select-failure-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  const graphService = {
    readThreadState: async () => {
      throw new Error('checkpoint unavailable');
    },
  } as unknown as LocalAgentGraphService;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
      { modelProfileId: 'secondary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    chatGraphService: graphService,
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-selection-failure',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-failure',
      sessionId: created.session.id,
      modelProfileId: 'secondary',
    });
    const failed = sent.find((message) => (
      message.type === 'model.select.error'
      && message.requestId === 'select-failure'
    ));
    assert.equal(failed?.type, 'model.select.error');
    if (failed?.type !== 'model.select.error') return;
    assert.equal(failed.code, 'selection_failed');

    const persisted = JSON.parse(
      readFileSync(runtimeConfig.tuiSessionPath, 'utf8'),
    ) as {
      sessions: Record<string, { modelProfileId?: string }>;
    };
    assert.equal(
      persisted.sessions[created.session.id]?.modelProfileId,
      'primary',
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('removed session profile stays visible and blocks runs until explicitly replaced', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-removed-'));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const initialProfiles = createTestModelProfileRegistry([
    { modelProfileId: 'primary' },
    { modelProfileId: 'removed' },
  ], 'primary');
  const initialSent: LocalAgentServerMessage[] = [];
  const initialPeer = createPeer(initialSent);
  const initialHandlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: initialProfiles,
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, { loadContext: loadTestContext });

  let sessionId = '';
  try {
    await initialHandlers.peerHandlers.onSessionNew(initialPeer, {
      type: 'session.new',
      requestId: 'new-removed',
    });
    const created = initialSent.find((message) => (
      message.type === 'session.new.result'
    ));
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;
    sessionId = created.session.id;
    await initialHandlers.peerHandlers.onModelSelect(initialPeer, {
      type: 'model.select',
      requestId: 'select-removed',
      sessionId,
      modelProfileId: 'removed',
    });
  } finally {
    initialHandlers.close();
  }

  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, { loadContext: loadTestContext });
  try {
    await handlers.peerHandlers.onSessionSnapshotGet(peer, {
      type: 'session.snapshot.get',
      requestId: 'snapshot-removed',
    });
    const snapshot = sent.find((message) => (
      message.type === 'session.snapshot.result'
    ));
    assert.equal(snapshot?.type, 'session.snapshot.result');
    if (snapshot?.type !== 'session.snapshot.result') return;
    assert.equal(snapshot.snapshot.session.runtime?.modelProfileId, 'removed');
    assert.equal(
      snapshot.snapshot.session.runtime?.modelProfileAvailable,
      false,
    );

    await handlers.peerHandlers.onChatRequest(peer, {
      type: 'chat_request',
      requestId: 'blocked-run',
      message: 'must not fall back',
    });
    const blocked = sent.find((message) => (
      message.type === 'event'
      && message.event.type === 'error'
      && message.event.requestId === 'blocked-run'
    ));
    assert.equal(blocked?.type, 'event');
    if (blocked?.type !== 'event' || blocked.event.type !== 'error') return;
    assert.match(blocked.event.message, /Unknown model profile "removed"/);

    await handlers.peerHandlers.onModelList(peer, {
      type: 'model.list',
      requestId: 'list-removed',
      sessionId,
    });
    const listed = sent.find((message) => message.type === 'model.list.result');
    assert.equal(listed?.type, 'model.list.result');
    if (listed?.type !== 'model.list.result') return;
    assert.equal(
      listed.profiles.find((profile) => profile.id === 'removed')?.available,
      false,
    );

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'repair-profile',
      sessionId,
      modelProfileId: 'primary',
    });
    const repaired = sent.find((message) => (
      message.type === 'model.select.result'
      && message.requestId === 'repair-profile'
    ));
    assert.equal(repaired?.type, 'model.select.result');
    if (repaired?.type !== 'model.select.result') return;
    assert.equal(repaired.selectedProfileId, 'primary');
    assert.equal(
      repaired.snapshot.session.runtime?.modelProfileAvailable,
      true,
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('model selection is rejected while the active session is running', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-running-'));
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  const started = deferred<void>();
  const release = deferred<void>();
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
      { modelProfileId: 'secondary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    runChat: async () => {
      started.resolve();
      await release.promise;
      return { status: 'interrupted' };
    },
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-running',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;
    const running = handlers.peerHandlers.onChatRequest(peer, {
      type: 'chat_request',
      requestId: 'chat-running',
      message: 'stay active',
    });
    await started.promise;

    await handlers.peerHandlers.onSessionSnapshotGet(peer, {
      type: 'session.snapshot.get',
      requestId: 'snapshot-running',
    });
    const runningSnapshot = sent.find((message) => (
      message.type === 'session.snapshot.result'
      && message.requestId === 'snapshot-running'
    ));
    assert.equal(runningSnapshot?.type, 'session.snapshot.result');
    if (runningSnapshot?.type !== 'session.snapshot.result') return;
    assert.equal(runningSnapshot.snapshot.session.activeRun?.requestId, 'chat-running');
    assert.equal(runningSnapshot.snapshot.session.activeRun?.state, 'running');

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-running',
      sessionId: created.session.id,
      modelProfileId: 'secondary',
    });
    const rejected = sent.find((message) => (
      message.type === 'model.select.error'
      && message.requestId === 'select-running'
    ));
    assert.equal(rejected?.type, 'model.select.error');
    if (rejected?.type !== 'model.select.error') return;
    assert.equal(rejected.code, 'run_active');
    release.resolve();
    await running;
  } finally {
    release.resolve();
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('completion snapshot does not reintroduce a settled active run', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-snapshot-settled-'));
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  const refreshStarted = deferred<void>();
  const releaseRefresh = deferred<void>();
  let checkpointReads = 0;
  const graphService = {
    readThreadState: async () => {
      checkpointReads += 1;
      if (checkpointReads === 1) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return {
        messages: [],
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
  } as unknown as LocalAgentGraphService;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps(),
    capabilityArtifactStore: testArtifactStore,
  }, {
    chatGraphService: graphService,
    loadContext: loadTestContext,
    runChat: async () => ({ status: 'completed', reply: 'done' }),
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-settled',
    });
    const running = handlers.peerHandlers.onChatRequest(peer, {
      type: 'chat_request',
      requestId: 'chat-settled',
      message: 'finish',
    });
    await refreshStarted.promise;

    await handlers.peerHandlers.onSessionSnapshotGet(peer, {
      type: 'session.snapshot.get',
      requestId: 'snapshot-settled',
    });
    const snapshot = sent.find((message) => (
      message.type === 'session.snapshot.result'
      && message.requestId === 'snapshot-settled'
    ));
    assert.equal(snapshot?.type, 'session.snapshot.result');
    if (snapshot?.type !== 'session.snapshot.result') return;
    assert.equal(snapshot.snapshot.session.activeRun, null);

    releaseRefresh.resolve();
    await running;
  } finally {
    releaseRefresh.resolve();
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('model selection blocks a chat admitted by another peer until the selection settles', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-cross-peer-'));
  const selectionSent: LocalAgentServerMessage[] = [];
  const chatSent: LocalAgentServerMessage[] = [];
  const selectionPeer = createPeer(selectionSent);
  const chatPeer = createPeer(chatSent);
  const selectionReadStarted = deferred<void>();
  const releaseSelectionRead = deferred<void>();
  const chatStarted = deferred<void>();
  const releaseChat = deferred<void>();
  let chatStartCount = 0;
  const graphService = {
    readThreadState: async () => {
      selectionReadStarted.resolve();
      await releaseSelectionRead.promise;
      return {
        messages: [],
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
  } as unknown as LocalAgentGraphService;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
      { modelProfileId: 'secondary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    chatGraphService: graphService,
    runChat: async () => {
      chatStartCount += 1;
      chatStarted.resolve();
      await releaseChat.promise;
      return { status: 'interrupted' };
    },
  });

  try {
    await handlers.peerHandlers.onSessionNew(selectionPeer, {
      type: 'session.new',
      requestId: 'new-cross-peer',
    });
    const created = selectionSent.find((message) => (
      message.type === 'session.new.result'
    ));
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;

    const selecting = handlers.peerHandlers.onModelSelect(selectionPeer, {
      type: 'model.select',
      requestId: 'select-cross-peer',
      sessionId: created.session.id,
      modelProfileId: 'secondary',
    });
    await selectionReadStarted.promise;
    const running = handlers.peerHandlers.onChatRequest(chatPeer, {
      type: 'chat_request',
      requestId: 'chat-cross-peer',
      message: 'wait for selection',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(chatStartCount, 0);

    releaseSelectionRead.resolve();
    await selecting;
    await chatStarted.promise;
    assert.equal(chatStartCount, 1);
    const selected = selectionSent.find((message) => (
      message.type === 'model.select.result'
      && message.requestId === 'select-cross-peer'
    ));
    assert.equal(selected?.type, 'model.select.result');

    releaseChat.resolve();
    await running;
  } finally {
    releaseSelectionRead.resolve();
    releaseChat.resolve();
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('model selection is rejected while checkpoint state has pending review', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-review-'));
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  const review = {
    id: 'review-current',
    schemaVersion: 1,
    view: { kind: 'plain' as const, body: 'Approve?' },
    options: [{
      id: 'approve',
      label: 'Approve',
      decision: { type: 'approve' as const },
    }],
  };
  const graphService = {
    readThreadState: async () => ({
      messages: [],
      pendingHumanReview: { review },
      hasPendingContinuation: true,
    }),
  } as unknown as LocalAgentGraphService;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
      { modelProfileId: 'secondary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    chatGraphService: graphService,
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-review',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;
    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-review',
      sessionId: created.session.id,
      modelProfileId: 'secondary',
    });
    const rejected = sent.find((message) => (
      message.type === 'model.select.error'
      && message.requestId === 'select-review'
    ));
    assert.equal(rejected?.type, 'model.select.error');
    if (rejected?.type !== 'model.select.error') return;
    assert.equal(rejected.code, 'review_pending');
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('admitted images gate model selection through the transcript', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-image-ledger-'));
  const imagePath = join(workdir, 'renamed.bin');
  writeFileSync(imagePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('image-ledger'),
  ]));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  let providerMessage: { content?: unknown } | undefined;
  // The graph is stubbed, so stand in for the checkpoint the real run would
  // have written: the admitted message is what the session's modalities are
  // derived from.
  const persistedMessages: BaseMessage[] = [];
  const graphService = {
    readThreadState: async () => ({
      messages: persistedMessages,
      pendingHumanReview: null,
      hasPendingContinuation: false,
    }),
  } as unknown as LocalAgentGraphService;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: createTestModelProfileRegistry([
      {
        modelProfileId: 'vision-a',
        inputModalities: ['text', 'image'],
      },
      {
        modelProfileId: 'text-only',
        inputModalities: ['text'],
      },
      {
        modelProfileId: 'vision-b',
        inputModalities: ['text', 'image'],
      },
    ], 'vision-a'),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    chatGraphService: graphService,
    runChat: async (options) => {
      providerMessage = await options.prepareUserMessage?.();
      if (providerMessage) {
        persistedMessages.push(providerMessage as BaseMessage);
      }
      return { status: 'interrupted' };
    },
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-image',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;
    const sessionId = created.session.id;

    await handlers.peerHandlers.onChatRequest(peer, {
      type: 'chat_request',
      requestId: 'chat-image',
      message: 'understand this',
      attachments: [{
        id: 'image-1',
        source: 'local-path',
        kind: 'file',
        path: imagePath,
        name: 'renamed.bin',
      }],
    });
    // Images travel as standard data URLs, so nothing has to resolve a custom
    // reference scheme before the model call.
    const serializedMessage = JSON.stringify(providerMessage?.content);
    assert.match(serializedMessage, /data:image\/png;base64,/);
    assert.doesNotMatch(serializedMessage, /renamed\.bin/);

    await handlers.peerHandlers.onModelList(peer, {
      type: 'model.list',
      requestId: 'list-after-image',
      sessionId,
    });
    const listed = sent.find((message) => (
      message.type === 'model.list.result'
      && message.requestId === 'list-after-image'
    ));
    assert.equal(listed?.type, 'model.list.result');
    if (listed?.type !== 'model.list.result') return;
    assert.deepEqual(listed.requiredInputModalities, ['text', 'image']);
    assert.equal(
      listed.profiles.find((profile) => profile.id === 'text-only')?.compatible,
      false,
    );

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-text-after-image',
      sessionId,
      modelProfileId: 'text-only',
    });
    const incompatible = sent.find((message) => (
      message.type === 'model.select.error'
      && message.requestId === 'select-text-after-image'
    ));
    assert.equal(incompatible?.type, 'model.select.error');
    if (incompatible?.type !== 'model.select.error') return;
    assert.equal(incompatible.code, 'profile_incompatible');

    await handlers.peerHandlers.onModelSelect(peer, {
      type: 'model.select',
      requestId: 'select-vision-after-image',
      sessionId,
      modelProfileId: 'vision-b',
    });
    const selected = sent.find((message) => (
      message.type === 'model.select.result'
      && message.requestId === 'select-vision-after-image'
    ));
    assert.equal(selected?.type, 'model.select.result');
    if (selected?.type !== 'model.select.result') return;
    assert.equal(selected.selectedProfileId, 'vision-b');
    assert.deepEqual(
      selected.snapshot.session.runtime?.requiredInputModalities,
      ['text', 'image'],
    );
    assert.equal(
      selected.snapshot.session.runtime?.modelProfileCompatible,
      true,
    );

    // The session file carries no modality ledger: the requirement is read back
    // off the transcript, so there is no second copy that could drift from it.
    const persisted = JSON.parse(
      readFileSync(runtimeConfig.tuiSessionPath, 'utf8'),
    ) as {
      sessions: Record<string, { requiredInputModalities?: string[] }>;
    };
    assert.deepEqual(
      persisted.sessions[sessionId]?.requiredInputModalities,
      ['text'],
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('text-only selected profile rejects image admission before graph invocation', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-model-image-reject-'));
  const imagePath = join(workdir, 'image.png');
  writeFileSync(imagePath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('reject-image'),
  ]));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  const sent: LocalAgentServerMessage[] = [];
  const peer = createPeer(sent);
  let graphInvocations = 0;
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: createTestModelProfileRegistry([
      {
        modelProfileId: 'text-only',
        inputModalities: ['text'],
      },
    ]),
    globalReviewPolicyMode: 'require_authorization',
    autoAuthorizationSafetyLevel: 'strict',
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    runChat: async (options) => {
      await options.prepareUserMessage?.();
      graphInvocations += 1;
      return { status: 'interrupted' };
    },
  });

  try {
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-text-only',
    });
    const created = sent.find((message) => message.type === 'session.new.result');
    assert.equal(created?.type, 'session.new.result');
    if (created?.type !== 'session.new.result') return;
    await handlers.peerHandlers.onChatRequest(peer, {
      type: 'chat_request',
      requestId: 'reject-image',
      message: 'describe',
      attachments: [{
        id: 'image-1',
        source: 'local-path',
        kind: 'file',
        path: imagePath,
        name: 'image.png',
      }],
    });
    assert.equal(graphInvocations, 0);
    const error = sent.find((message) => (
      message.type === 'event'
      && message.event.type === 'error'
      && message.event.requestId === 'reject-image'
    ));
    assert.equal(error?.type, 'event');
    if (error?.type !== 'event' || error.event.type !== 'error') return;
    assert.match(error.event.message, /does not support image input/);
    const persisted = JSON.parse(
      readFileSync(runtimeConfig.tuiSessionPath, 'utf8'),
    ) as {
      sessions: Record<string, { requiredInputModalities?: string[] }>;
    };
    assert.deepEqual(
      persisted.sessions[created.session.id]?.requiredInputModalities,
      ['text'],
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('runtime config update persists the safety level, acknowledges, and reaches authoritative snapshots', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-policy-update-'));
  const sent: LocalAgentServerMessage[] = [];
  const persisted: Array<{ mode: string; safetyLevel: string }> = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps({
      globalReviewPolicyMode: 'require_authorization',
    }),
  }, {
    persistGlobalReviewPolicyMode: (mode, safetyLevel) => {
      persisted.push({ mode, safetyLevel });
    },
  });

  try {
    await handlers.peerHandlers.onRuntimeConfigUpdate(peer, {
      type: 'runtime_config.update',
      requestId: 'policy-1',
      globalReviewPolicyMode: 'auto_authorization',
      autoAuthorizationSafetyLevel: 'relaxed',
    });
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-1',
    });

    assert.deepEqual(persisted, [{
      mode: 'auto_authorization',
      safetyLevel: 'relaxed',
    }]);
    assert.deepEqual(sent[0], {
      type: 'runtime_config.result',
      requestId: 'policy-1',
      globalReviewPolicyMode: 'auto_authorization',
      autoAuthorizationSafetyLevel: 'relaxed',
    });
    const snapshot = sent.find((message) => (
      message.type === 'session.new.result'
    ));
    assert.equal(
      snapshot?.type === 'session.new.result'
        ? snapshot.snapshot.session.runtime?.globalReviewPolicyMode
        : null,
      'auto_authorization',
    );
    assert.equal(
      snapshot?.type === 'session.new.result'
        ? snapshot.snapshot.session.runtime?.autoAuthorizationSafetyLevel
        : null,
      'relaxed',
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('runtime config update preserves the configured safety level when the message omits it', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-policy-preserve-'));
  const sent: LocalAgentServerMessage[] = [];
  const persisted: Array<{ mode: string; safetyLevel: string }> = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps({
      globalReviewPolicyMode: 'auto_authorization',
      autoAuthorizationSafetyLevel: 'relaxed',
    }),
  }, {
    persistGlobalReviewPolicyMode: (mode, safetyLevel) => {
      persisted.push({ mode, safetyLevel });
    },
  });

  try {
    await handlers.peerHandlers.onRuntimeConfigUpdate(peer, {
      type: 'runtime_config.update',
      requestId: 'policy-preserve-1',
      globalReviewPolicyMode: 'full_access',
    });
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-preserve-1',
    });

    assert.deepEqual(persisted, [{
      mode: 'full_access',
      safetyLevel: 'relaxed',
    }]);
    assert.deepEqual(sent[0], {
      type: 'runtime_config.result',
      requestId: 'policy-preserve-1',
      globalReviewPolicyMode: 'full_access',
      autoAuthorizationSafetyLevel: 'relaxed',
    });
    const snapshot = sent.find((message) => (
      message.type === 'session.new.result'
    ));
    assert.equal(
      snapshot?.type === 'session.new.result'
        ? snapshot.snapshot.session.runtime?.autoAuthorizationSafetyLevel
        : null,
      'relaxed',
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('runtime config update reports persistence failures without changing runtime state', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-policy-failure-'));
  const sent: LocalAgentServerMessage[] = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const handlers = createLocalServerHandlers({
    serverMode: 'chat',
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps({
      globalReviewPolicyMode: 'require_authorization',
    }),
  }, {
    persistGlobalReviewPolicyMode: () => {
      throw new Error('config is read-only');
    },
  });

  try {
    await handlers.peerHandlers.onRuntimeConfigUpdate(peer, {
      type: 'runtime_config.update',
      requestId: 'policy-1',
      globalReviewPolicyMode: 'full_access',
    });
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-1',
    });

    assert.deepEqual(sent[0], {
      type: 'runtime_config.error',
      requestId: 'policy-1',
      message: 'config is read-only',
    });
    const snapshot = sent.find((message) => (
      message.type === 'session.new.result'
    ));
    assert.equal(
      snapshot?.type === 'session.new.result'
        ? snapshot.snapshot.session.runtime?.globalReviewPolicyMode
        : null,
      'require_authorization',
    );
  } finally {
    handlers.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
