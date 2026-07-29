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
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles,
    globalReviewPolicyMode: 'require_authorization',
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
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: initialProfiles,
    globalReviewPolicyMode: 'require_authorization',
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
    actorId: 'pet-a',
    workdir,
    runtimeConfig,
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
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
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
      { modelProfileId: 'secondary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
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
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'primary' },
      { modelProfileId: 'secondary' },
    ], 'primary'),
    globalReviewPolicyMode: 'require_authorization',
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

test('image admission persists a monotonic requirement and gates model selection', async () => {
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
  const handlers = createLocalServerHandlers({
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
    capabilityArtifactStore: testArtifactStore,
  }, {
    loadContext: loadTestContext,
    runChat: async (options) => {
      providerMessage = await options.prepareUserMessage?.();
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
    const serializedMessage = JSON.stringify(providerMessage?.content);
    assert.match(serializedMessage, /pinpawo-local-image:/);
    assert.doesNotMatch(serializedMessage, /base64|renamed\.bin/);

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

    const persisted = JSON.parse(
      readFileSync(runtimeConfig.tuiSessionPath, 'utf8'),
    ) as {
      sessions: Record<string, { requiredInputModalities?: string[] }>;
    };
    assert.deepEqual(
      persisted.sessions[sessionId]?.requiredInputModalities,
      ['text', 'image'],
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

test('runtime config update persists, acknowledges, and reaches authoritative snapshots', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-policy-update-'));
  const sent: LocalAgentServerMessage[] = [];
  const persisted: string[] = [];
  const peer: LocalServerPeer = {
    isConnected: () => true,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
  const handlers = createLocalServerHandlers({
    actorId: 'pet-a',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps({
      globalReviewPolicyMode: 'require_authorization',
    }),
  }, {
    persistGlobalReviewPolicyMode: (mode) => {
      persisted.push(mode);
    },
  });

  try {
    await handlers.peerHandlers.onRuntimeConfigUpdate(peer, {
      type: 'runtime_config.update',
      requestId: 'policy-1',
      globalReviewPolicyMode: 'auto_authorization',
    });
    await handlers.peerHandlers.onSessionNew(peer, {
      type: 'session.new',
      requestId: 'new-1',
    });

    assert.deepEqual(persisted, ['auto_authorization']);
    assert.deepEqual(sent[0], {
      type: 'runtime_config.result',
      requestId: 'policy-1',
      globalReviewPolicyMode: 'auto_authorization',
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
